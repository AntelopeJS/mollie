import assert from "node:assert/strict";
import {
  CreateCustomer,
  CreatePayment,
  GetPayment,
  ListPaymentMethods,
  VerifyWebhook,
} from "@antelopejs/interface-payment";

import { MANDATE_WAIT_MS } from "../implementations/payment/saved-method";
import {
  Eventually,
  FORM,
  Key,
  PrimaryAccount,
  Reference,
  RequireStandIn,
  ReturnUrl,
  TEST_TIMEOUT,
  WebhookBody,
} from "./support/helpers";

const AMOUNT = { value: 1900, currency: "EUR" };
const STUCK_MS = 10 * MANDATE_WAIT_MS;
const PAID_AT_RESOLUTION_MS = 1500;
const QUICK_MS = MANDATE_WAIT_MS / 10;

async function paidSavingPayment(
  paymentMethod: string,
): Promise<{ customer: string; payment: string }> {
  const customer = await CreateCustomer({ name: "Lagging mandate" }, Key());
  const created = await CreatePayment(
    {
      amount: AMOUNT,
      reference: Reference(),
      customer: customer.id,
      paymentMethod,
      savePaymentMethod: true,
      returnUrl: ReturnUrl(),
    },
    Key(),
  );
  await Eventually(
    () => PrimaryAccount().payments.get(created.id)?.status === "paid",
    `${created.id} to be paid`,
  );
  return { customer: customer.id, payment: created.id };
}

async function timed<T>(work: Promise<T>): Promise<[T, number]> {
  const started = Date.now();
  const result = await work;
  return [result, Date.now() - started];
}

async function withMandateLag<T>(
  method: "creditcard" | "directdebit",
  lagMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const lags = PrimaryAccount().mandateLagMs;
  const before = lags.get(method);
  lags.set(method, lagMs);
  try {
    return await work();
  } finally {
    if (before === undefined) lags.delete(method);
    else lags.set(method, before);
  }
}

describe("[mollie] a saved card, as soon as its payment reads succeeded", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("is listed, though Mollie turns the mandate valid after it marks the payment paid", async () => {
    const { customer, payment } = await paidSavingPayment("creditcard");
    assert.equal((await GetPayment(payment)).status, "succeeded");
    const saved = await ListPaymentMethods(customer);
    assert.deepEqual(
      saved.map((method) => method.type),
      ["card"],
    );
  });

  it("is listed when the payment became known through its webhook", async () => {
    const { customer, payment } = await paidSavingPayment("creditcard");
    const event = await VerifyWebhook({
      body: WebhookBody(payment),
      headers: FORM,
    });
    assert.equal(event?.type, "payment.succeeded");
    assert.equal((await ListPaymentMethods(customer)).length, 1);
  });

  it("holds the payment back once, for the budget, when the mandate stays pending", async () => {
    await withMandateLag("creditcard", STUCK_MS, async () => {
      const { customer, payment } = await paidSavingPayment("creditcard");
      const [first, firstMs] = await timed(GetPayment(payment));
      assert.equal(first.status, "succeeded");
      assert.ok(
        firstMs >= MANDATE_WAIT_MS - PAID_AT_RESOLUTION_MS &&
          firstMs <= MANDATE_WAIT_MS + PAID_AT_RESOLUTION_MS,
        `the first read took ${firstMs} ms`,
      );
      const [second, secondMs] = await timed(GetPayment(payment));
      assert.equal(second.status, "succeeded");
      assert.ok(secondMs < QUICK_MS, `the next read took ${secondMs} ms`);
      const [listed, listMs] = await timed(ListPaymentMethods(customer));
      assert.deepEqual(listed, []);
      assert.ok(listMs < QUICK_MS, `the listing took ${listMs} ms`);
    });
  });

  it("does not wait for a bank mandate that stays pending", async () => {
    await withMandateLag("directdebit", STUCK_MS, async () => {
      const { customer, payment } = await paidSavingPayment("ideal");
      const [read, readMs] = await timed(GetPayment(payment));
      assert.equal(read.status, "succeeded");
      assert.ok(readMs < QUICK_MS, `the read took ${readMs} ms`);
      const [listed, listMs] = await timed(ListPaymentMethods(customer));
      assert.deepEqual(listed, []);
      assert.ok(listMs < QUICK_MS, `the listing took ${listMs} ms`);
    });
  });
});
