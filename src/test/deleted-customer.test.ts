import assert from "node:assert/strict";
import {
  CreateCheckoutSession,
  CreateCustomer,
  CreatePayment,
  CustomerNotFoundError,
  DeleteCustomer,
  PaymentError,
  PaymentNotFoundError,
} from "@antelopejs/interface-payment";

import { MollieApiError } from "../mollie/errors";
import { TranslatingNamed } from "../implementations/payment/errors";
import { IsMollieMandate } from "../mollie/resources";
import { CurrentHarness } from "./support/harness";
import {
  Key,
  Reference,
  Rejected,
  ReturnUrl,
  TEST_TIMEOUT,
} from "./support/helpers";

const EUR = (value: number) => ({ value, currency: "EUR" });

interface DeletedCustomer {
  id: string;
  savedMethod: string;
}

async function deletedCustomer(): Promise<DeletedCustomer> {
  const customer = await CreateCustomer({ name: "Deleted payer" }, Key());
  const mandate = await CurrentHarness().client.request(
    {
      method: "POST",
      path: `/customers/${customer.id}/mandates`,
      body: {
        method: "directdebit",
        consumerName: "T. Test",
        consumerAccount: "NL55INGB0000000000",
      },
    },
    IsMollieMandate,
  );
  await DeleteCustomer(customer.id, Key());
  return { id: customer.id, savedMethod: `${customer.id}:${mandate.id}` };
}

async function assertNamesCustomer(
  work: Promise<unknown>,
  customer: DeletedCustomer,
): Promise<void> {
  const error = await Rejected(work, CustomerNotFoundError);
  assert.equal(
    error.message,
    new CustomerNotFoundError(customer.id, "customer").message,
    "names the customer, not a payment method or a payment",
  );
}

describe("[mollie] creating a payment for a customer Mollie has deleted", function () {
  this.timeout(TEST_TIMEOUT);

  it("reports the customer as not found on a hosted payment", async () => {
    const customer = await deletedCustomer();
    await assertNamesCustomer(
      CreatePayment(
        {
          amount: EUR(2500),
          reference: Reference(),
          paymentMethod: "ideal",
          customer: customer.id,
          returnUrl: ReturnUrl(),
        },
        Key(),
      ),
      customer,
    );
  });

  it("reports the customer as not found when charging its saved method", async () => {
    const customer = await deletedCustomer();
    await assertNamesCustomer(
      CreatePayment(
        {
          amount: EUR(2500),
          reference: Reference(),
          paymentMethod: customer.savedMethod,
          customer: customer.id,
          offSession: true,
        },
        Key(),
      ),
      customer,
    );
  });

  it("reports the customer as not found when only authorizing its saved method", async () => {
    const customer = await deletedCustomer();
    await assertNamesCustomer(
      CreatePayment(
        {
          amount: EUR(2500),
          reference: Reference(),
          paymentMethod: customer.savedMethod,
          offSession: true,
          authorizeOnly: true,
        },
        Key(),
      ),
      customer,
    );
  });

  it("reports the customer as not found on a checkout session", async () => {
    const customer = await deletedCustomer();
    await assertNamesCustomer(
      CreateCheckoutSession(
        {
          amount: EUR(2500),
          reference: Reference(),
          customer: customer.id,
          successUrl: ReturnUrl(),
          cancelUrl: ReturnUrl(),
        },
        Key(),
      ),
      customer,
    );
  });
});

async function translated(
  status: number,
  named: Parameters<typeof TranslatingNamed>[0],
  field?: string,
): Promise<Error | undefined> {
  try {
    await TranslatingNamed(named, () =>
      Promise.reject(new MollieApiError(status, { detail: "refused", field })),
    );
  } catch (error) {
    return error instanceof Error ? error : undefined;
  }
  return undefined;
}

describe("[mollie] a refusal of a call that names no payment", () => {
  const named = { customer: "cst_named", paymentMethod: "cst_named:mdt_named" };

  it("blames the customer for a 410 or a customerId field, even beside a saved method", async () => {
    for (const refusal of [
      translated(410, named),
      translated(404, named, "customerId"),
    ]) {
      const error = await refusal;
      assert.ok(error instanceof CustomerNotFoundError);
      assert.equal(error.message, "No such customer: cst_named");
    }
  });

  it("blames the saved method for a not-found that does not name the customer", async () => {
    const error = await translated(404, named, "mandateId");
    assert.ok(error instanceof CustomerNotFoundError);
    assert.equal(error.message, "No such payment method: cst_named:mdt_named");
  });

  it("blames the customer for a bare not-found when no saved method is named", async () => {
    const error = await translated(404, { customer: "cst_named" });
    assert.ok(error instanceof CustomerNotFoundError);
    assert.equal(error.message, "No such customer: cst_named");
  });

  it("is a plain PaymentError when nothing is named, or when Mollie refuses for another reason", async () => {
    for (const refusal of [
      translated(404, {}),
      translated(422, named, "mandateId"),
    ]) {
      const error = await refusal;
      assert.ok(error instanceof PaymentError);
      assert.ok(!(error instanceof PaymentNotFoundError));
      assert.ok(!(error instanceof CustomerNotFoundError));
    }
  });
});
