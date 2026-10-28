import { Page } from "./payments-api";
import type { Request } from "./payments-api";
import { NO_CONTENT, NotFound, Ok, Unprocessable } from "./responses";
import { type Account, NewId, NowIso, type StandInResponse } from "./state";
import type {
  MollieCustomer,
  MollieMandate,
  MollieSubscription,
} from "../../mollie/types";

export function CustomerOf(account: Account, id: string): MollieCustomer {
  const customer = account.customers.get(id);
  if (!customer || account.deletedCustomers.has(id)) {
    throw NotFound("customer", id);
  }
  return customer;
}

export function MandateOf(
  account: Account,
  customerId: string,
  id: string,
): MollieMandate {
  CustomerOf(account, customerId);
  const mandate = account.mandates.get(id);
  if (!mandate || mandate.customerId !== customerId) {
    throw NotFound("mandate", id);
  }
  return mandate;
}

export function CancelSubscriptionRecord(
  subscription: MollieSubscription,
): void {
  subscription.status = "canceled";
  subscription.canceledAt = NowIso();
  subscription.nextPaymentDate = null;
}

function cancelConnected(
  account: Account,
  matches: (subscription: MollieSubscription) => boolean,
): void {
  for (const subscription of account.subscriptions.values()) {
    if (subscription.status !== "canceled" && matches(subscription)) {
      CancelSubscriptionRecord(subscription);
    }
  }
}

export function CreateCustomer(request: Request): StandInResponse {
  const { body } = request;
  const customer: MollieCustomer = {
    resource: "customer",
    id: NewId("cst"),
    name: (body.name as string | undefined) ?? null,
    email: (body.email as string | undefined) ?? null,
    metadata: body.metadata ?? null,
    createdAt: NowIso(),
  };
  request.account.customers.set(customer.id, customer);
  return Ok(customer, 201);
}

export function GetCustomer(request: Request): StandInResponse {
  return Ok(CustomerOf(request.account, request.params[0]));
}

export function UpdateCustomer(request: Request): StandInResponse {
  const customer = CustomerOf(request.account, request.params[0]);
  for (const field of ["name", "email", "metadata"] as const) {
    if (field in request.body) {
      Object.assign(customer, { [field]: request.body[field] });
    }
  }
  return Ok(customer);
}

export function DeleteCustomer(request: Request): StandInResponse {
  const { account } = request;
  const customer = CustomerOf(account, request.params[0]);
  account.deletedCustomers.add(customer.id);
  for (const mandate of account.mandates.values()) {
    if (mandate.customerId === customer.id) mandate.status = "invalid";
  }
  cancelConnected(
    account,
    (subscription) => subscription.customerId === customer.id,
  );
  return NO_CONTENT;
}

export function ListCustomerPayments(request: Request): StandInResponse {
  const customerId = request.params[0];
  CustomerOf(request.account, customerId);
  const owned = [...request.account.payments.values()].filter(
    (payment) => payment.customerId === customerId,
  );
  return Page(
    owned,
    request.query,
    "payments",
    `${request.hooks.baseUrl}/v2/customers/${customerId}/payments`,
  );
}

export function ListMandates(request: Request): StandInResponse {
  const customerId = request.params[0];
  CustomerOf(request.account, customerId);
  const owned = [...request.account.mandates.values()].filter(
    (mandate) => mandate.customerId === customerId,
  );
  return Page(
    owned,
    request.query,
    "mandates",
    `${request.hooks.baseUrl}/v2/customers/${customerId}/mandates`,
  );
}

export function GetMandate(request: Request): StandInResponse {
  return Ok(MandateOf(request.account, request.params[0], request.params[1]));
}

export function CreateMandate(request: Request): StandInResponse {
  const customerId = request.params[0];
  CustomerOf(request.account, customerId);
  const { body } = request;
  if (typeof body.consumerName !== "string") {
    throw Unprocessable("The consumer name is missing", "consumerName");
  }
  if (
    body.method !== "directdebit" ||
    typeof body.consumerAccount !== "string"
  ) {
    throw Unprocessable(
      "Only SEPA Direct Debit mandates with an IBAN are supported here",
      "method",
    );
  }
  const mandate: MollieMandate = {
    resource: "mandate",
    id: NewId("mdt"),
    method: "directdebit",
    status: "valid",
    scopes: ["customer-not-present"],
    details: { consumerAccount: body.consumerAccount },
    customerId,
    createdAt: NowIso(),
  };
  request.account.mandates.set(mandate.id, mandate);
  return Ok(mandate, 201);
}

export function RevokeMandate(request: Request): StandInResponse {
  const [customerId, mandateId] = request.params;
  const mandate = MandateOf(request.account, customerId, mandateId);
  if (mandate.status === "invalid") throw NotFound("mandate", mandateId);
  mandate.status = "invalid";
  cancelConnected(
    request.account,
    (subscription) => subscription.mandateId === mandate.id,
  );
  return NO_CONTENT;
}
