import assert from "node:assert/strict";
import { VerifyWebhook } from "@antelopejs/interface-payment";
import {
  CancelSubscription,
  CreateSubscription,
  type Subscription,
  type SubscriptionEvent,
  SubscriptionEvents,
  type SubscriptionRequest,
} from "@antelopejs/interface-subscriptions";

import { CurrentHarness } from "./support/harness";
import type { MolliePayment } from "../mollie/types";
import { NewPayer, type Payer } from "./support/payers";
import { RenewSubscription } from "./stand-in/subscriptions-api";
import { CancelSubscriptionRecord } from "./stand-in/customers-api";
import { ParsePaymentMethodId, ParseSubscriptionId } from "../mollie/ids";
import "./support/relay";
import {
  Eventually,
  FORM,
  Key,
  PrimaryAccount,
  Reference,
  RequireStandIn,
  SettledPayment,
  StandIn,
  TEST_TIMEOUT,
  WebhookBody,
} from "./support/helpers";

const HANDLER = "mollie-module-events";
const received: SubscriptionEvent[] = [];

function monthly(payer: Payer): SubscriptionRequest {
  return {
    reference: Reference(),
    customer: payer.customer,
    paymentMethod: payer.paymentMethod,
    amount: { value: 1900, currency: "EUR" },
    interval: "month",
  };
}

function renew(subscription: Subscription): MolliePayment {
  const { child } = ParseSubscriptionId(subscription.id) ?? { child: "" };
  const mollie = PrimaryAccount().subscriptions.get(child);
  if (!mollie) throw new Error(`No stand-in subscription ${subscription.id}`);
  return RenewSubscription(PrimaryAccount(), StandIn().paymentHooks, mollie);
}

function eventsOf(
  subscription: Subscription,
  type?: string,
): SubscriptionEvent[] {
  return received.filter(
    (event) =>
      event.subscription.id === subscription.id &&
      (!type || event.type === type),
  );
}

async function declining<T>(payer: Payer, work: () => Promise<T>): Promise<T> {
  const { child } = ParsePaymentMethodId(payer.paymentMethod) ?? { child: "" };
  CurrentHarness().policy.decliningMandates.add(child);
  try {
    return await work();
  } finally {
    CurrentHarness().policy.decliningMandates.delete(child);
  }
}

describe("[mollie] subscription events", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
    SubscriptionEvents.register(HANDLER, (event) => {
      received.push(event);
    });
  });

  after(() => {
    SubscriptionEvents.unregister(HANDLER);
  });

  it("raises created when a subscription is made, with the same id on a replayed creation", async () => {
    const payer = await NewPayer();
    const body = monthly(payer);
    const key = Key();
    const subscription = await CreateSubscription(body, key);
    await CreateSubscription(body, key);
    const created = eventsOf(subscription, "subscription.created");
    assert.equal(created.length, 2);
    assert.equal(created[0].id, created[1].id);
  });

  it("raises payment_succeeded from the webhook of a renewal Mollie fired", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(monthly(payer), Key());
    const renewal = renew(subscription);
    await Eventually(
      () =>
        eventsOf(subscription).some((event) => event.payment === renewal.id),
      "the renewal's event",
    );
    const event = eventsOf(subscription).find(
      (candidate) => candidate.payment === renewal.id,
    );
    assert.equal(event?.type, "subscription.payment_succeeded");
    assert.equal(event?.subscription.latestPayment, renewal.id);
  });

  it("raises payment_failed with the subscription past_due", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(monthly(payer), Key());
    await SettledPayment(subscription.latestPayment ?? "");
    const renewal = await declining(payer, async () => {
      const failed = renew(subscription);
      await SettledPayment(failed.id);
      return failed;
    });
    await Eventually(
      () =>
        eventsOf(subscription).some((event) => event.payment === renewal.id),
      "the failed renewal's event",
    );
    const event = eventsOf(subscription).find(
      (candidate) => candidate.payment === renewal.id,
    );
    assert.equal(event?.type, "subscription.payment_failed");
    assert.equal(event?.subscription.status, "past_due");
  });

  it("raises canceled after payment_failed when Mollie gives up", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(monthly(payer), Key());
    const renewal = await declining(payer, async () => {
      const failed = renew(subscription);
      await SettledPayment(failed.id);
      return failed;
    });
    const { child } = ParseSubscriptionId(subscription.id) ?? { child: "" };
    const record = PrimaryAccount().subscriptions.get(child);
    assert.ok(record);
    CancelSubscriptionRecord(record);
    await VerifyWebhook({ body: WebhookBody(renewal.id), headers: FORM });
    const canceled = eventsOf(subscription, "subscription.canceled");
    assert.equal(canceled.length >= 1, true);
    assert.equal(canceled[0].subscription.endReason, "payment_failed");
  });

  it("fails the delivery while a handler throws, and redelivers under the same event id", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(monthly(payer), Key());
    const charge = subscription.latestPayment ?? "";
    await SettledPayment(charge);
    const seen: string[] = [];
    let shouldThrow = true;
    SubscriptionEvents.register(`${HANDLER}-flaky`, (event) => {
      if (event.payment !== charge) return;
      seen.push(event.id);
      if (shouldThrow) throw new Error("handler not ready");
    });
    try {
      await assert.rejects(() =>
        VerifyWebhook({ body: WebhookBody(charge), headers: FORM }),
      );
      shouldThrow = false;
      const event = await VerifyWebhook({
        body: WebhookBody(charge),
        headers: FORM,
      });
      assert.equal(event?.type, "payment.succeeded");
      assert.equal(seen.length >= 2, true);
      assert.equal(new Set(seen).size, 1);
    } finally {
      SubscriptionEvents.unregister(`${HANDLER}-flaky`);
    }
  });

  it("raises canceled once for a cancellation, and the same id when it is replayed", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(monthly(payer), Key());
    const key = Key();
    await CancelSubscription(subscription.id, key, "now");
    await CancelSubscription(subscription.id, key, "now");
    const canceled = eventsOf(subscription, "subscription.canceled");
    assert.equal(canceled.length, 2);
    assert.equal(canceled[0].id, canceled[1].id);
    assert.equal(canceled[0].subscription.status, "canceled");
  });
});

function subscriptionReadsDuring<T>(
  subscription: Subscription,
  work: () => Promise<T>,
): Promise<[T, number]> {
  const { parent, child } = ParseSubscriptionId(subscription.id) ?? {
    parent: "",
    child: "",
  };
  const path = `/v2/customers/${parent}/subscriptions/${child}`;
  const before = PrimaryAccount().requests.length;
  return work().then((result) => [
    result,
    PrimaryAccount()
      .requests.slice(before)
      .filter((request) => request.method === "GET" && request.path === path)
      .length,
  ]);
}

describe("[mollie] subscription reads per webhook", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("reads a renewal's subscription from Mollie once per webhook delivery", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(monthly(payer), Key());
    const renewal = renew(subscription);
    await Eventually(
      () =>
        StandIn().deliveries.some(
          (delivery) => delivery.body === `id=${renewal.id}`,
        ),
      "the renewal's delivery",
    );
    const [event, reads] = await subscriptionReadsDuring(subscription, () =>
      VerifyWebhook({ body: WebhookBody(renewal.id), headers: FORM }),
    );
    assert.equal(event?.type, "payment.succeeded");
    assert.equal(reads, 1);
  });

  it("reads no subscription for an open renewal, whose webhook raises nothing", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(monthly(payer), Key());
    const renewal = renew(subscription);
    const [event, reads] = await subscriptionReadsDuring(subscription, () =>
      VerifyWebhook({ body: WebhookBody(renewal.id), headers: FORM }),
    );
    assert.equal(event, undefined);
    assert.equal(reads, 0);
  });
});
