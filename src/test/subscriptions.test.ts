import assert from "node:assert/strict";
import {
  DetachPaymentMethod,
  GetCustomer,
  GetPayment,
} from "@antelopejs/interface-payment";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  InvalidSubscriptionRequestError,
  ListSubscriptions,
  SUBSCRIPTION_METADATA_KEY,
  type Subscription,
  SubscriptionNotFoundError,
  SubscriptionPaymentError,
  type SubscriptionRequest,
} from "@antelopejs/interface-subscriptions";

import { IsJsonObject, ReadOwn } from "../mollie/metadata";
import { CurrentHarness } from "./support/harness";
import { NewPayer, type Payer } from "./support/payers";
import { RenewSubscription } from "./stand-in/subscriptions-api";
import { CancelSubscriptionRecord } from "./stand-in/customers-api";
import type { MolliePayment, MollieSubscription } from "../mollie/types";
import { ParsePaymentMethodId, ParseSubscriptionId } from "../mollie/ids";
import {
  FormatDate,
  NextDateFrom,
  StartOf,
} from "../implementations/subscriptions/calendar";
import {
  Key,
  PrimaryAccount,
  Reference,
  Rejected,
  RequireStandIn,
  SettledPayment,
  StandIn,
  TEST_TIMEOUT,
  Within,
} from "./support/helpers";
import "./support/relay";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PERIOD = { value: 1900, currency: "EUR" };

function request(
  payer: Payer,
  overrides: Partial<SubscriptionRequest> = {},
): SubscriptionRequest {
  return {
    reference: Reference(),
    customer: payer.customer,
    paymentMethod: payer.paymentMethod,
    amount: PERIOD,
    interval: "month",
    ...overrides,
  };
}

function atMollie(subscription: Subscription): MollieSubscription {
  const { child } = ParseSubscriptionId(subscription.id) ?? { child: "" };
  const found = PrimaryAccount().subscriptions.get(child);
  if (!found)
    throw new Error(`No stand-in subscription for ${subscription.id}`);
  return found;
}

function renew(subscription: Subscription): MolliePayment {
  return RenewSubscription(
    PrimaryAccount(),
    StandIn().paymentHooks,
    atMollie(subscription),
  );
}

describe("[mollie] subscription schedule", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("ends a trial at the start of the first Amsterdam day after the requested time", async () => {
    const payer = await NewPayer();
    const requested = Date.now() + 3 * DAY_MS + 5 * HOUR_MS;
    const subscription = await CreateSubscription(
      request(payer, { trialEnd: requested }),
      Key(),
    );

    const date = NextDateFrom(requested);
    assert.equal(subscription.status, "trialing");
    assert.equal(subscription.trialEnd, StartOf(date));
    assert.ok(
      subscription.trialEnd >= requested,
      "nothing is charged before the requested end",
    );
    assert.ok(subscription.trialEnd - requested < DAY_MS);
    assert.equal(subscription.currentPeriodEnd, subscription.trialEnd);
    assert.equal(atMollie(subscription).startDate, FormatDate(date));
    assert.equal(subscription.latestPayment, undefined);
  });

  it("defers to a billing anchor without charging, rounded the same way", async () => {
    const payer = await NewPayer();
    const anchor = Date.now() + 2 * DAY_MS + HOUR_MS;
    const subscription = await CreateSubscription(
      request(payer, { billingAnchor: anchor }),
      Key(),
    );
    assert.equal(subscription.status, "active");
    assert.equal(subscription.trialEnd, undefined);
    assert.equal(subscription.currentPeriodEnd, StartOf(NextDateFrom(anchor)));
    assert.equal(subscription.latestPayment, undefined);
  });

  it("bills a year as twelve months and reads it back as a year", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(
      request(payer, { interval: "year" }),
      Key(),
    );
    assert.equal(atMollie(subscription).interval, "12 months");
    assert.equal(subscription.interval, "year");
    assert.equal(subscription.intervalCount, 1);
  });

  it("refuses a period longer than Mollie bills, before anything reaches Mollie", async () => {
    const payer = await NewPayer();
    for (const overrides of [
      { interval: "year" as const, intervalCount: 2 },
      { interval: "week" as const, intervalCount: 53 },
      { interval: "month" as const, intervalCount: 13 },
    ]) {
      await assert.rejects(
        () => CreateSubscription(request(payer, overrides), Key()),
        InvalidSubscriptionRequestError,
      );
    }
    assert.deepEqual(await ListSubscriptions(payer.customer), []);
  });

  it("lets a period run out, and reports it ended at the period end afterwards", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(request(payer), Key());
    await CancelSubscription(subscription.id, Key(), "period_end");

    const after = await Within(
      subscription.currentPeriodEnd - Date.now() + HOUR_MS,
      () => GetSubscription(subscription.id),
    );
    assert.equal(after.status, "canceled");
    assert.equal(after.endedAt, subscription.currentPeriodEnd);
    assert.equal(after.endReason, "requested");
    assert.equal(after.cancelAtPeriodEnd, false);
  });

  it("keeps an early end after another subscription of the customer ends early later", async () => {
    const payer = await NewPayer();
    const first = await CreateSubscription(request(payer), Key());
    const second = await CreateSubscription(
      request(payer, { billingAnchor: Date.now() + 40 * DAY_MS }),
      Key(),
    );
    await CancelSubscription(first.id, Key(), "period_end");
    const endedEarly = await CancelSubscription(first.id, Key(), "now");
    const past = first.currentPeriodEnd - Date.now() + HOUR_MS;
    const read = await Within(past, async () => {
      await CancelSubscription(second.id, Key(), "period_end");
      await CancelSubscription(second.id, Key(), "now");
      return GetSubscription(first.id);
    });
    assert.equal(read.status, "canceled");
    assert.equal(read.endedAt, endedEarly.endedAt);
  });

  it("keeps metadata written outside the module visible on a customer after an early end", async () => {
    const payer = await NewPayer();
    await CurrentHarness().client.request({
      method: "PATCH",
      path: `/customers/${payer.customer}`,
      body: { metadata: { crm: "c-9" } },
    });
    const subscription = await CreateSubscription(request(payer), Key());
    await CancelSubscription(subscription.id, Key(), "period_end");
    await CancelSubscription(subscription.id, Key(), "now");
    assert.deepEqual((await GetCustomer(payer.customer)).metadata, {
      crm: "c-9",
    });
  });

  it("keeps an early end on later reads, and the customer's own metadata intact", async () => {
    const payer = await NewPayer({ crm: "c-77" });
    const subscription = await CreateSubscription(request(payer), Key());
    await CancelSubscription(subscription.id, Key(), "period_end");
    await CancelSubscription(subscription.id, Key(), "now");

    const read = await GetSubscription(subscription.id);
    assert.equal(read.status, "canceled");
    assert.ok((read.endedAt ?? Infinity) < subscription.currentPeriodEnd);
    assert.deepEqual((await GetCustomer(payer.customer)).metadata, {
      crm: "c-77",
    });
  });
});

describe("[mollie] subscription creation", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("replays a creation after Mollie has forgotten the idempotency key", async () => {
    const payer = await NewPayer();
    const key = Key();
    const body = request(payer);
    const first = await CreateSubscription(body, key);
    const replay = await Within(2 * HOUR_MS, () =>
      CreateSubscription(body, key),
    );
    assert.equal(replay.id, first.id);
    assert.equal(replay.latestPayment, first.latestPayment);
    const owned = [...PrimaryAccount().subscriptions.values()].filter(
      (subscription) => subscription.customerId === payer.customer,
    );
    assert.equal(owned.length, 1);
  });

  it("charges the first period once, even when the record of the charge was lost and Mollie forgot the key", async () => {
    const payer = await NewPayer();
    const key = Key();
    const body = request(payer);
    const first = await CreateSubscription(body, key);
    const mollie = atMollie(first);
    const metadata = mollie.metadata;
    assert.ok(IsJsonObject(metadata) && IsJsonObject(metadata.antelope));
    const own = { ...metadata.antelope };
    delete own.firstPayment;
    mollie.metadata = { ...metadata, antelope: own };

    const replay = await Within(2 * HOUR_MS, () =>
      CreateSubscription(body, key),
    );
    assert.equal(replay.latestPayment, first.latestPayment);
    const charges = [...PrimaryAccount().payments.values()].filter(
      (payment) =>
        ReadOwn<{ subscription: string }>(payment.metadata)?.subscription ===
        first.id,
    );
    assert.equal(charges.length, 1);
  });

  it("refuses a first period Mollie declines at once, leaves nothing listed, and refuses the replay alike", async () => {
    const payer = await NewPayer();
    const { child } = ParsePaymentMethodId(payer.paymentMethod) ?? {
      child: "",
    };
    PrimaryAccount().declinesAtCreation.add(child);
    const key = Key();
    const body = request(payer);
    const first = await Rejected(
      CreateSubscription(body, key),
      SubscriptionPaymentError,
    );
    assert.equal(first.payment.status, "failed");
    assert.equal(first.payment.failure?.code, "declined");
    assert.deepEqual(await ListSubscriptions(payer.customer), []);

    const replay = await Rejected(
      CreateSubscription(body, key),
      SubscriptionPaymentError,
    );
    assert.equal(replay.payment.id, first.payment.id);
    PrimaryAccount().declinesAtCreation.delete(child);
  });
});

describe("[mollie] renewals Mollie fires", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("reports a renewal under the subscription's reference and metadata, which Mollie forwards", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(
      request(payer, { metadata: { plan: "gold" } }),
      Key(),
    );
    const renewal = renew(subscription);
    const read = await GetPayment(renewal.id);
    assert.equal(read.reference, subscription.reference);
    assert.deepEqual(read.metadata, {
      plan: "gold",
      [SUBSCRIPTION_METADATA_KEY]: subscription.id,
    });
  });

  it("marks a renewal as the subscription's and reports it as the latest payment", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(request(payer), Key());
    const renewal = renew(subscription);

    const settled = await SettledPayment(renewal.id);
    assert.equal(settled.status, "succeeded");
    assert.equal(
      settled.metadata?.[SUBSCRIPTION_METADATA_KEY],
      subscription.id,
    );
    const read = await GetSubscription(subscription.id);
    assert.equal(read.latestPayment, renewal.id);
    assert.equal(read.status, "active");
  });

  it("goes past_due when a renewal fails, and back to active when the next one is paid", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(request(payer), Key());
    await SettledPayment(subscription.latestPayment ?? "");
    const { child } = ParsePaymentMethodId(payer.paymentMethod) ?? {
      child: "",
    };
    CurrentHarness().policy.decliningMandates.add(child);
    try {
      const failed = renew(subscription);
      assert.equal((await SettledPayment(failed.id)).status, "failed");
      assert.equal((await GetSubscription(subscription.id)).status, "past_due");
    } finally {
      CurrentHarness().policy.decliningMandates.delete(child);
    }
    const paid = renew(subscription);
    assert.equal((await SettledPayment(paid.id)).status, "succeeded");
    assert.equal((await GetSubscription(subscription.id)).status, "active");
  });

  it("ends for payment_failed when Mollie gives up, without a request from anyone", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(request(payer), Key());
    const { child } = ParsePaymentMethodId(payer.paymentMethod) ?? {
      child: "",
    };
    CurrentHarness().policy.decliningMandates.add(child);
    try {
      const failed = renew(subscription);
      await SettledPayment(failed.id);
    } finally {
      CurrentHarness().policy.decliningMandates.delete(child);
    }
    CancelSubscriptionRecord(atMollie(subscription));
    const read = await GetSubscription(subscription.id);
    assert.equal(read.status, "canceled");
    assert.equal(read.endReason, "payment_failed");
  });

  it("ends when its mandate is revoked, as Mollie documents", async () => {
    const payer = await NewPayer();
    const subscription = await CreateSubscription(request(payer), Key());
    await DetachPaymentMethod(payer.paymentMethod, Key());
    const read = await GetSubscription(subscription.id);
    assert.equal(read.status, "canceled");
    assert.equal(read.endReason, "requested");
  });
});

describe("[mollie] subscriptions made elsewhere on the account", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("are not listed, read, or marked on their charges", async () => {
    const payer = await NewPayer();
    const { child } = ParsePaymentMethodId(payer.paymentMethod) ?? {
      child: "",
    };
    const foreign = await CurrentHarness().client.request<MollieSubscription>({
      method: "POST",
      path: `/customers/${payer.customer}/subscriptions`,
      body: {
        amount: { currency: "EUR", value: "5.00" },
        interval: "1 month",
        description: "Made in the dashboard",
        mandateId: child,
      },
    });
    assert.deepEqual(await ListSubscriptions(payer.customer), []);
    await assert.rejects(
      () => GetSubscription(`${payer.customer}:${foreign.id}`),
      SubscriptionNotFoundError,
    );
    const renewal = RenewSubscription(
      PrimaryAccount(),
      StandIn().paymentHooks,
      foreign,
    );
    await SettledPayment(renewal.id);
    assert.equal(
      (await GetPayment(renewal.id)).metadata?.[SUBSCRIPTION_METADATA_KEY],
      undefined,
    );
  });
});
