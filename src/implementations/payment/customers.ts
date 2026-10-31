import { IsMollieCustomer, IsMollieMandate } from "../../mollie/resources";
import type {
  Customer,
  CustomerRequest,
  PaymentMethod,
} from "@antelopejs/interface-payment";

import { GetAccount } from "../../accounts";
import { NotFound, Translating } from "./errors";
import { DefinedFields, NonEmpty } from "../../mollie/fields";
import { IsMollieId, ParsePaymentMethodId } from "../../mollie/ids";
import { IsChargeableOffSession, ToPaymentMethod } from "./mapping";
import type { MollieCustomer } from "../../mollie/types";
import { ReadCallerMetadata, WriteMetadata } from "../../mollie/metadata";

const CUSTOMER_ENTITY = "customer";
const METHOD_ENTITY = "payment method";
const MANDATE_PAGE = "/mandates?limit=250";

function toCustomer(customer: MollieCustomer): Customer {
  const metadata = ReadCallerMetadata(customer.metadata);
  return {
    id: customer.id,
    ...DefinedFields({
      email: customer.email ?? undefined,
      name: customer.name ?? undefined,
      metadata: NonEmpty(metadata),
    }),
  };
}

function assertCustomerId(id: string): void {
  if (!IsMollieId("customer", id)) throw NotFound(id, CUSTOMER_ENTITY);
}

export async function CreateCustomer(
  request: CustomerRequest,
  idempotencyKey: string,
  provider?: string,
): Promise<Customer> {
  const account = GetAccount(provider);
  return Translating("", CUSTOMER_ENTITY, async () =>
    toCustomer(
      await account.client.request(
        {
          method: "POST",
          path: "/customers",
          body: {
            ...DefinedFields({ email: request.email, name: request.name }),
            metadata: WriteMetadata({}, request.metadata),
          },
          idempotencyKey,
        },
        IsMollieCustomer,
      ),
    ),
  );
}

export async function GetCustomer(
  id: string,
  provider?: string,
): Promise<Customer> {
  assertCustomerId(id);
  const account = GetAccount(provider);
  return Translating(id, CUSTOMER_ENTITY, async () =>
    toCustomer(
      await account.client.request(
        {
          method: "GET",
          path: `/customers/${id}`,
        },
        IsMollieCustomer,
      ),
    ),
  );
}

export async function DeleteCustomer(
  id: string,
  _idempotencyKey: string,
  provider?: string,
): Promise<void> {
  assertCustomerId(id);
  const account = GetAccount(provider);
  await Translating(id, CUSTOMER_ENTITY, () =>
    account.client.execute({ method: "DELETE", path: `/customers/${id}` }),
  );
}

export async function ListPaymentMethods(
  customer: string,
  provider?: string,
): Promise<PaymentMethod[]> {
  assertCustomerId(customer);
  const account = GetAccount(provider);
  return Translating(customer, CUSTOMER_ENTITY, async () => {
    const mandates = await account.client.list(
      `/customers/${customer}${MANDATE_PAGE}`,
      "mandates",
      IsMollieMandate,
    );
    return mandates
      .filter(IsChargeableOffSession)
      .map((mandate) => ToPaymentMethod(mandate, customer))
      .sort((first, second) => second.createdAt - first.createdAt);
  });
}

export async function DetachPaymentMethod(
  id: string,
  _idempotencyKey: string,
  provider?: string,
): Promise<void> {
  const parsed = ParsePaymentMethodId(id);
  if (!parsed) throw NotFound(id, METHOD_ENTITY);
  const account = GetAccount(provider);
  await Translating(id, METHOD_ENTITY, () =>
    account.client.execute({
      method: "DELETE",
      path: `/customers/${parsed.parent}/mandates/${parsed.child}`,
    }),
  );
}
