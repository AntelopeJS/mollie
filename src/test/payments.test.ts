import assert from "node:assert/strict";
import {
  CancelPayment,
  CapturePayment,
  CreateCheckoutSession,
  CreatePayment,
  CustomerNotFoundError,
  GetPayment,
  GetRefund,
  InvalidPaymentStateError,
  ListPaymentMethods,
  PaymentError,
  type PaymentLocale,
  type PaymentRequest,
  RefundPayment,
} from "@antelopejs/interface-payment";

import { ReadOwn } from "../mollie/metadata";
import { ParsePaymentMethodId } from "../mollie/ids";
import { CurrentHarness, SECOND_ACCOUNT } from "./support/harness";
import {
  Key,
  PrimaryAccount,
  Reference,
  Rejected,
  RequireStandIn,
  ReturnUrl,
  SettledPayment,
  StandIn,
  TEST_TIMEOUT,
  Within,
} from "./support/helpers";

const HOUR_MS = 60 * 60 * 1000;
const EUR = (value: number) => ({ value, currency: "EUR" });

function offSession(
  paymentMethod: string,
  extra: Partial<PaymentRequest> = {},
) {
  return CreatePayment(
    {
      amount: EUR(2500),
      reference: Reference(),
      paymentMethod,
      offSession: true,
      ...extra,
    },
    Key(),
  );
}

async function paidPayment(): Promise<string> {
  const payment = await offSession(CurrentHarness().chargeable);
  const settled = await SettledPayment(payment.id);
  assert.equal(settled.status, "succeeded");
  return payment.id;
}

describe("[mollie] authorize and capture, settled the way Mollie settles", function () {
  this.timeout(TEST_TIMEOUT);

  it("is pending when created, authorized once Mollie says so, then captured in part", async () => {
    const created = await offSession(CurrentHarness().chargeable, {
      authorizeOnly: true,
    });
    assert.equal(
      created.status,
      "pending",
      "Mollie authorizes after the creating call",
    );

    const authorized = await SettledPayment(created.id);
    assert.equal(authorized.status, "authorized");
    assert.equal(authorized.amountCaptured.value, 0);

    const captured = await CapturePayment(created.id, Key(), EUR(1000));
    assert.equal(captured.status, "succeeded");
    assert.equal(captured.amountCaptured.value, 1000);
    assert.equal(captured.amount.value, 2500);
  });

  it("releases an authorization on cancel", async () => {
    const created = await offSession(CurrentHarness().chargeable, {
      authorizeOnly: true,
    });
    await SettledPayment(created.id);
    const canceled = await CancelPayment(created.id, Key());
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.amountCaptured.value, 0);
  });

  it("refuses to hold a payment on a method Mollie cannot capture manually", async function () {
    RequireStandIn(this);
    const { parent } = ParsePaymentMethodId(CurrentHarness().chargeable) ?? {
      parent: "",
    };
    const mandate = await CurrentHarness().client.request<{ id: string }>({
      method: "POST",
      path: `/customers/${parent}/mandates`,
      body: {
        method: "directdebit",
        consumerName: "T. Test",
        consumerAccount: "NL55INGB0000000000",
      },
    });
    const before = PrimaryAccount().payments.size;
    await assert.rejects(
      () => offSession(`${parent}:${mandate.id}`, { authorizeOnly: true }),
      (error) =>
        error instanceof PaymentError && /directdebit/.test(error.message),
    );
    assert.equal(
      PrimaryAccount().payments.size,
      before,
      "nothing reaches Mollie",
    );
  });

  it("offers only manual-capture methods on a hosted page that only authorizes", async function () {
    RequireStandIn(this);
    const session = await CreateCheckoutSession(
      {
        amount: EUR(2500),
        reference: Reference(),
        successUrl: ReturnUrl(),
        cancelUrl: ReturnUrl(),
        authorizeOnly: true,
      },
      Key(),
    );
    const sent = PrimaryAccount()
      .requests.filter((request) => request.path === "/v2/payments")
      .at(-1);
    assert.equal(sent?.body.captureMode, "manual");
    assert.deepEqual(sent?.body.method, [
      "creditcard",
      "klarna",
      "billie",
      "riverty",
      "vipps",
      "mobilepay",
      "paypal",
      "billink",
    ]);
    assert.equal(session.status, "requires_action");
  });

  it("refuses to hold an iDEAL payment, which Mollie would capture at once", async () => {
    await assert.rejects(
      () =>
        CreatePayment(
          {
            amount: EUR(100),
            reference: Reference(),
            paymentMethod: "ideal",
            returnUrl: ReturnUrl(),
            authorizeOnly: true,
          },
          Key(),
        ),
      (error) => error instanceof PaymentError && /ideal/.test(error.message),
    );
  });
});

describe("[mollie] the hosted page language", function () {
  this.timeout(TEST_TIMEOUT);

  async function sentLocale(locale: PaymentLocale) {
    await CreateCheckoutSession(
      {
        amount: EUR(2500),
        reference: Reference(),
        successUrl: ReturnUrl(),
        cancelUrl: ReturnUrl(),
        locale,
      },
      Key(),
    );
    return PrimaryAccount()
      .requests.filter((request) => request.path === "/v2/payments")
      .at(-1)?.body?.locale;
  }

  it("presets the language a payer asked for, in the region Mollie offers it in", async function () {
    RequireStandIn(this);
    assert.equal(await sentLocale("fr"), "fr_FR");
    assert.equal(await sentLocale("en"), "en_US");
    assert.equal(await sentLocale("en-GB"), "en_GB");
    assert.equal(await sentLocale("pt-BR"), "pt_PT");
  });

  it("lets Mollie pick from the browser for a language it does not offer", async function () {
    RequireStandIn(this);
    assert.equal(await sentLocale("ja"), undefined);
    assert.equal(await sentLocale("auto"), undefined);
  });
});

describe("[mollie] declines arrive after the creating call", function () {
  this.timeout(TEST_TIMEOUT);

  it("reports the decline with a reason once Mollie has it", async () => {
    const created = await offSession(CurrentHarness().declining);
    assert.equal(created.status, "pending");
    const failed = await SettledPayment(created.id);
    assert.equal(failed.status, "failed");
    assert.ok(failed.failure);
    assert.equal(failed.failure.code, "declined");
  });
});

describe("[mollie] replaying captures and refunds", function () {
  this.timeout(TEST_TIMEOUT);

  it("returns the original capture for a replayed key, within Mollie's hour and after it", async () => {
    const created = await offSession(CurrentHarness().chargeable, {
      authorizeOnly: true,
    });
    await SettledPayment(created.id);
    const key = Key();
    const first = await CapturePayment(created.id, key, EUR(1000));
    const replay = await CapturePayment(created.id, key, EUR(1000));
    const later = await Within(2 * HOUR_MS, () =>
      CapturePayment(created.id, key, EUR(1000)),
    );
    for (const payment of [first, replay, later]) {
      assert.equal(payment.status, "succeeded");
      assert.equal(payment.amountCaptured.value, 1000);
    }
    await assert.rejects(
      () => CapturePayment(created.id, Key(), EUR(1000)),
      InvalidPaymentStateError,
    );
  });

  it("returns the original refund for a replayed key, even once nothing is left to refund", async () => {
    const id = await paidPayment();
    const key = Key();
    const first = await RefundPayment({ payment: id }, key);
    const replay = await RefundPayment({ payment: id }, key);
    assert.equal(replay.id, first.id);
    assert.equal((await GetPayment(id)).amountRefunded.value, 2500);
  });

  it("does not refund twice when a partial refund is replayed after Mollie forgot the key", async () => {
    const id = await paidPayment();
    const key = Key();
    const first = await RefundPayment({ payment: id, amount: EUR(500) }, key);
    const later = await Within(2 * HOUR_MS, () =>
      RefundPayment({ payment: id, amount: EUR(500) }, key),
    );
    assert.equal(later.id, first.id);
    assert.equal((await GetPayment(id)).amountRefunded.value, 500);
  });
});

describe("[mollie] payments edge cases", function () {
  this.timeout(TEST_TIMEOUT);

  it("refunds whatever is left when no amount is given, and keeps the reason out of the caller's metadata", async () => {
    const id = await paidPayment();
    await RefundPayment({ payment: id, amount: EUR(500) }, Key());
    const refund = await RefundPayment(
      { payment: id, reason: "fraudulent", metadata: { ticket: "42" } },
      Key(),
    );
    assert.equal(refund.amount.value, 2000);
    assert.deepEqual(refund.metadata, { ticket: "42" });
    const read = await GetRefund(refund.id);
    assert.equal(read.payment, id);
    assert.equal((await GetPayment(id)).amountRefunded.value, 2500);
  });

  it("refuses a refund once nothing is left, from the payment it read", async () => {
    const id = await paidPayment();
    await RefundPayment({ payment: id }, Key());
    await assert.rejects(
      () => RefundPayment({ payment: id }, Key()),
      InvalidPaymentStateError,
    );
  });

  it("does not read an account suspension (422) as a payment-state refusal", async function () {
    RequireStandIn(this);
    const id = await paidPayment();
    StandIn().outage = 422;
    try {
      const error = await Rejected(
        RefundPayment({ payment: id, amount: EUR(100) }, Key()),
        PaymentError,
      );
      assert.ok(
        !(error instanceof InvalidPaymentStateError),
        `must not be ${InvalidPaymentStateError.name}`,
      );
    } finally {
      StandIn().outage = undefined;
    }
  });

  it("treats cancelling an already cancelled payment as a replay", async () => {
    const created = await CreatePayment(
      {
        amount: EUR(2500),
        reference: Reference(),
        paymentMethod: "ideal",
        returnUrl: ReturnUrl(),
      },
      Key(),
    );
    const first = await CancelPayment(created.id, Key());
    const again = await CancelPayment(created.id, Key());
    assert.equal(first.status, "canceled");
    assert.equal(again.status, "canceled");
  });

  it("refuses to cancel a captured payment", async () => {
    const id = await paidPayment();
    await assert.rejects(
      () => CancelPayment(id, Key()),
      InvalidPaymentStateError,
    );
  });

  it("sends zero-decimal currencies without decimals", async function () {
    RequireStandIn(this);
    const created = await CreatePayment(
      {
        amount: { value: 1500, currency: "JPY" },
        reference: Reference(),
        paymentMethod: "creditcard",
        returnUrl: ReturnUrl(),
      },
      Key(),
    );
    assert.equal(
      PrimaryAccount().payments.get(created.id)?.amount.value,
      "1500",
    );
    assert.deepEqual(created.amount, { value: 1500, currency: "JPY" });
  });

  it("hides its own reference inside the metadata it sends", async function () {
    RequireStandIn(this);
    const reference = Reference();
    const created = await CreatePayment(
      {
        amount: EUR(100),
        reference,
        paymentMethod: "ideal",
        returnUrl: ReturnUrl(),
        metadata: { a: "b" },
      },
      Key(),
    );
    const sent = PrimaryAccount().payments.get(created.id)?.metadata;
    assert.equal(ReadOwn<{ reference: string }>(sent)?.reference, reference);
    assert.deepEqual(created.metadata, { a: "b" });
  });
});

describe("[mollie] payment requests the module refuses itself", function () {
  this.timeout(TEST_TIMEOUT);

  it("refuses to charge a saved method for a customer it does not belong to", async () => {
    await assert.rejects(
      () =>
        CreatePayment(
          {
            amount: EUR(100),
            reference: Reference(),
            paymentMethod: CurrentHarness().chargeable,
            customer: "cst_someoneelse0",
            offSession: true,
          },
          Key(),
        ),
      CustomerNotFoundError,
    );
  });

  it("refuses an off-session payment without a saved method", async () => {
    await assert.rejects(() => offSession("creditcard"), PaymentError);
  });

  it("surfaces a reused idempotency key with other parameters as an error", async function () {
    RequireStandIn(this);
    const key = Key();
    await CreatePayment(
      {
        amount: EUR(100),
        reference: Reference(),
        paymentMethod: "ideal",
        returnUrl: ReturnUrl(),
      },
      key,
    );
    await assert.rejects(
      () =>
        CreatePayment(
          {
            amount: EUR(200),
            reference: Reference(),
            paymentMethod: "ideal",
            returnUrl: ReturnUrl(),
          },
          key,
        ),
      (error) => error instanceof PaymentError && error.providerCode === "400",
    );
  });

  it("lists only mandates Mollie can charge without the payer", async function () {
    RequireStandIn(this);
    const { parent, child } = ParsePaymentMethodId(
      CurrentHarness().chargeable,
    ) ?? { parent: "", child: "" };
    const account = PrimaryAccount();
    const presentOnly = {
      ...account.mandates.get(child)!,
      id: "mdt_presentonly0",
      scopes: ["customer-present"],
    };
    const revoked = {
      ...account.mandates.get(child)!,
      id: "mdt_revokedmndt0",
      status: "invalid" as const,
    };
    account.mandates.set(presentOnly.id, presentOnly);
    account.mandates.set(revoked.id, revoked);
    try {
      const listed = (await ListPaymentMethods(parent)).map(
        (method) => method.id,
      );
      assert.ok(listed.includes(CurrentHarness().chargeable));
      assert.ok(!listed.includes(`${parent}:${presentOnly.id}`));
      assert.ok(!listed.includes(`${parent}:${revoked.id}`));
    } finally {
      account.mandates.delete(presentOnly.id);
      account.mandates.delete(revoked.id);
    }
  });

  it("keeps each account's payments to itself", async function () {
    if (!CurrentHarness().target.secondApiKey) this.skip();
    const created = await CreatePayment(
      {
        amount: EUR(100),
        reference: Reference(),
        paymentMethod: "ideal",
        returnUrl: ReturnUrl(),
      },
      Key(),
      SECOND_ACCOUNT,
    );
    assert.equal((await GetPayment(created.id, SECOND_ACCOUNT)).id, created.id);
    await assert.rejects(() => GetPayment(created.id));
  });

  it("refuses a provider selector nobody configured", async () => {
    await assert.rejects(
      () => GetPayment("tr_abcdefghij", "nobody"),
      PaymentError,
    );
  });
});
