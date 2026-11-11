import assert from "node:assert/strict";
import {
  CreateCustomer,
  CreatePayment,
  GetPayment,
  ListPaymentMethods,
  VerifyWebhook,
} from "@antelopejs/interface-payment";

import {
  MANDATE_POLL_MS,
  MANDATE_WAIT_MS,
} from "../implementations/payment/saved-method";
import { IsoIn } from "./stand-in/state";
import {
  Eventually,
  FORM,
  Key,
  PrimaryAccount,
  Reference,
  RequireStandIn,
  ReturnUrl,
  StandIn,
  TEST_TIMEOUT,
  WebhookBody,
} from "./support/helpers";

const AMOUNT = { value: 1900, currency: "EUR" };
const STUCK_MS = 10 * MANDATE_WAIT_MS;
const CALLERS = 50;
const SLOW_READ_MS = 8_000;
const CLOCK_SKEW_MS = 60_000;
const OVERRUN_MS = 750;
const MANDATE_READ = /^\/v2\/customers\/[^/]+\/mandates\/[^/]+$/;
const PAID_AT_RESOLUTION_MS = 1500;
const QUICK_MS = MANDATE_WAIT_MS / 10;
const SHORT_LAG_MS = 1_500;
const FEW_CALLERS = 5;

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

describe("[mollie] the wait for a saved card's mandate", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("sends a bounded number of mandate reads however many callers wait on one payment", async () => {
    await withMandateLag("creditcard", STUCK_MS, async () => {
      const { payment } = await paidSavingPayment("creditcard");
      const account = PrimaryAccount();
      const reads = () =>
        account.requests.filter(
          (request) =>
            request.method === "GET" && MANDATE_READ.test(request.path),
        ).length;
      const before = reads();
      const answers = await Promise.all(
        Array.from({ length: CALLERS }, () => GetPayment(payment)),
      );
      assert.ok(answers.every((answer) => answer.status === "succeeded"));
      const sent = reads() - before;
      assert.ok(
        sent <= MANDATE_WAIT_MS / MANDATE_POLL_MS + 1,
        `${CALLERS} callers sent ${sent} mandate reads`,
      );
    });
  });

  it("never holds a call past the budget when a mandate read is slow", async () => {
    await withMandateLag("creditcard", STUCK_MS, async () => {
      const { payment } = await paidSavingPayment("creditcard");
      const slow = { method: "GET", path: MANDATE_READ, ms: SLOW_READ_MS };
      StandIn().latencies.push(slow);
      try {
        const [read, readMs] = await timed(GetPayment(payment));
        assert.equal(read.status, "succeeded");
        assert.ok(
          readMs <= MANDATE_WAIT_MS + OVERRUN_MS,
          `the read took ${readMs} ms`,
        );
      } finally {
        StandIn().latencies.splice(StandIn().latencies.indexOf(slow), 1);
      }
    });
  });

  it("waits once for a payment whose paidAt is ahead of the host clock", async () => {
    await withMandateLag("creditcard", STUCK_MS, async () => {
      const { payment } = await paidSavingPayment("creditcard");
      const stored = PrimaryAccount().payments.get(payment);
      assert.ok(stored);
      stored.paidAt = IsoIn(CLOCK_SKEW_MS);
      const [first, firstMs] = await timed(GetPayment(payment));
      assert.equal(first.status, "succeeded");
      assert.ok(
        firstMs <= MANDATE_WAIT_MS + OVERRUN_MS,
        `the first read took ${firstMs} ms`,
      );
      const [second, secondMs] = await timed(GetPayment(payment));
      assert.equal(second.status, "succeeded");
      assert.ok(secondMs < QUICK_MS, `the next read took ${secondMs} ms`);
    });
  });

  it("keeps every concurrent caller waiting past a failed mandate read", async () => {
    await withMandateLag("creditcard", SHORT_LAG_MS, async () => {
      const { customer, payment } = await paidSavingPayment("creditcard");
      StandIn().faults.push({ method: "GET", path: MANDATE_READ, status: 503 });
      const reads = await Promise.all(
        Array.from({ length: FEW_CALLERS }, () => GetPayment(payment)),
      );
      assert.ok(reads.every((read) => read.status === "succeeded"));
      assert.equal(
        (await ListPaymentMethods(customer)).length,
        1,
        "a failed read released the callers before the card was listable",
      );
    });
  });
});
