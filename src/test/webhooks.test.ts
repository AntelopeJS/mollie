import assert from "node:assert/strict";
import {
  CreatePayment,
  GetPayment,
  PaymentError,
  VerifyWebhook,
  WebhookVerificationError,
} from "@antelopejs/interface-payment";

import type { MolliePaymentStatus } from "../mollie/types";
import { CurrentHarness, SECOND_ACCOUNT } from "./support/harness";
import {
  FORM,
  Key,
  PrimaryAccount,
  Reference,
  RequireStandIn,
  Rejected,
  ReturnUrl,
  StandIn,
  TEST_TIMEOUT,
  WebhookBody,
} from "./support/helpers";

const AMOUNT = { value: 2500, currency: "EUR" };

async function openPayment(provider?: string): Promise<string> {
  const payment = await CreatePayment(
    {
      amount: AMOUNT,
      reference: Reference(),
      paymentMethod: "ideal",
      returnUrl: ReturnUrl(),
      metadata: { order: "webhook-test" },
    },
    Key(),
    provider,
  );
  return payment.id;
}

function settle(
  id: string,
  status: MolliePaymentStatus,
  apiKey?: string,
): void {
  const key = apiKey ?? CurrentHarness().target.apiKey;
  const payment = StandIn().account(key).payments.get(id);
  if (!payment) throw new Error(`No stand-in payment ${id}`);
  StandIn().settle(key, payment, status);
}

function deliver(
  id: string,
  extra: Record<string, string> = {},
  provider?: string,
) {
  return VerifyWebhook(
    { body: WebhookBody(id, extra), headers: FORM },
    provider,
  );
}

describe("[mollie] classic webhooks", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  const MAPPED: [MolliePaymentStatus, string, string][] = [
    ["paid", "payment.succeeded", "succeeded"],
    ["failed", "payment.failed", "failed"],
    ["canceled", "payment.canceled", "canceled"],
    ["expired", "payment.canceled", "canceled"],
  ];

  for (const [status, type, reported] of MAPPED) {
    it(`reads a ${status} payment back and reports ${type}`, async () => {
      const id = await openPayment();
      settle(id, status);

      const event = await deliver(id);

      assert.ok(event, "a modelled delivery must produce an event");
      assert.equal(event.type, type);
      assert.equal(event.payment?.id, id);
      assert.equal(event.payment?.status, reported);
      assert.equal((await GetPayment(id)).status, reported);
      assert.equal(event.payment?.reference.startsWith("module-test-"), true);
      assert.deepEqual(event.payment?.metadata, { order: "webhook-test" });
      assert.ok(
        event.createdAt > Date.UTC(2020, 0, 1),
        "createdAt is epoch milliseconds",
      );
    });
  }

  it("reports nothing for a payment that is still open", async () => {
    assert.equal(await deliver(await openPayment()), undefined);
  });

  it("takes the status from Mollie, never from the body", async () => {
    const id = await openPayment();
    settle(id, "failed");

    const event = await deliver(id, { status: "paid", amount: "999999.00" });

    assert.equal(event?.type, "payment.failed");
    assert.equal(event?.payment?.status, "failed");
    assert.equal(event?.payment?.amount.value, AMOUNT.value);
    assert.ok(event?.payment?.failure, "a failed payment says why");
  });

  it("ignores a forged success for a payment Mollie has not settled", async () => {
    const id = await openPayment();
    assert.equal(await deliver(id, { status: "paid" }), undefined);
  });

  it("gives the same event id to every delivery of one state, and a new one for the next", async () => {
    const id = await openPayment();
    settle(id, "paid");
    const first = await deliver(id);
    const again = await deliver(id);
    assert.equal(first?.id, again?.id);
    assert.notEqual(first?.id, `${id}:failed`);
  });

  it("refuses a body that names no Mollie payment", async () => {
    for (const body of [
      '{"id":"tr_abcdefghij"}',
      "id=",
      "id=re_abcdefghij",
      "payment=tr_abcdefghij",
      "",
    ]) {
      await assert.rejects(
        () => VerifyWebhook({ body: Buffer.from(body), headers: FORM }),
        WebhookVerificationError,
        body,
      );
    }
  });

  it("refuses a payment Mollie does not have on this account", async () => {
    await assert.rejects(
      () => deliver("tr_doesnotexist0"),
      WebhookVerificationError,
    );
  });

  it("refuses a payment of another account, and verifies it on its own", async function () {
    if (!CurrentHarness().target.secondApiKey) this.skip();
    const id = await openPayment(SECOND_ACCOUNT);
    settle(id, "paid", CurrentHarness().target.secondApiKey);

    await assert.rejects(() => deliver(id), WebhookVerificationError);
    assert.equal(
      (await deliver(id, {}, SECOND_ACCOUNT))?.type,
      "payment.succeeded",
    );
  });

  it("does not read an outage as a forged delivery", async () => {
    const id = await openPayment();
    settle(id, "paid");
    StandIn().outage = 503;
    try {
      const error = await Rejected(deliver(id), PaymentError);
      assert.ok(
        !(error instanceof WebhookVerificationError),
        "an outage must not answer 403",
      );
    } finally {
      StandIn().outage = undefined;
    }
    assert.equal((await deliver(id))?.type, "payment.succeeded");
  });

  it("is what the stand-in's own webhook calls reach", async () => {
    const id = await openPayment();
    settle(id, "paid");
    const account = PrimaryAccount();
    assert.equal(
      account.payments.get(id)?.webhookUrl,
      CurrentHarness().target.webhookUrl,
    );
  });
});
