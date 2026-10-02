import assert from "node:assert/strict";
import {
  CreateCustomer,
  CreatePayment,
  ListPaymentMethods,
} from "@antelopejs/interface-payment";

import { DefinedFields } from "../../mollie/fields";
import { Key, Reference, ReturnUrl, SettledPayment } from "./helpers";

const PERIOD = { value: 1900, currency: "EUR" };

export interface Payer {
  customer: string;
  paymentMethod: string;
}

async function SaveMethod(customer: string): Promise<string> {
  const known = new Set(
    (await ListPaymentMethods(customer)).map((method) => method.id),
  );
  const payment = await CreatePayment(
    {
      amount: PERIOD,
      reference: Reference(),
      customer,
      paymentMethod: "creditcard",
      savePaymentMethod: true,
      returnUrl: ReturnUrl(),
    },
    Key(),
  );
  assert.equal((await SettledPayment(payment.id)).status, "succeeded");
  const saved = (await ListPaymentMethods(customer)).find(
    (method) => !known.has(method.id),
  );
  assert.ok(saved, "the first payment must leave a mandate");
  return saved.id;
}

export async function NewPayer(
  metadata?: Record<string, string>,
): Promise<Payer> {
  const customer = await CreateCustomer(
    { name: "Module Test", ...DefinedFields({ metadata }) },
    Key(),
  );
  return {
    customer: customer.id,
    paymentMethod: await SaveMethod(customer.id),
  };
}
