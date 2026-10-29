import { Page, type Request } from "./payments-api";
import { NotFound, Ok, Unprocessable } from "./responses";
import { Lookup } from "../../mollie/fields";
import type {
  JsonValue,
  MolliePayment,
  MollieSubscription,
} from "../../mollie/types";
import {
  CancelSubscriptionRecord,
  CustomerOf,
  MandateOf,
} from "./customers-api";
import {
  type Account,
  CountOf,
  NewId,
  NowIso,
  type StandInResponse,
  Text,
  TextOf,
} from "./state";
import { IsJsonString } from "../../mollie/metadata";
import {
  AssertWebhookUrl,
  type PaymentHooks,
  PaymentLinks,
  ReadAmount,
} from "./payments";

const INTERVAL = /^(\d+) (day|days|week|weeks|month|months)$/;
const MAXIMUM_BY_UNIT = {
  day: 365,
  month: 12,
  week: 52,
} satisfies Record<string, number>;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_PER_WEEK = 7;
const UPDATABLE = [
  "amount",
  "description",
  "interval",
  "mandateId",
  "metadata",
  "startDate",
  "times",
  "webhookUrl",
] as const;

function readInterval(value: JsonValue | undefined): string {
  const match = INTERVAL.exec(Text(value));
  const unit = match?.[2].replace(/s$/, "") ?? "";
  const maximum = Lookup(MAXIMUM_BY_UNIT, unit);
  if (
    !match ||
    Number(match[1]) < 1 ||
    (maximum !== undefined && Number(match[1]) > maximum)
  ) {
    throw Unprocessable(
      "The interval is invalid. The maximum interval is one year (12 months, 52 weeks, or 365 days)",
      "interval",
    );
  }
  return Text(value);
}

function readStartDate(value: JsonValue | undefined): string {
  const today = NowIso().slice(0, 10);
  const date = value === undefined ? today : Text(value);
  if (!ISO_DATE.test(date)) {
    throw Unprocessable(
      "The start date must be in YYYY-MM-DD format",
      "startDate",
    );
  }
  return date;
}

function assertUniqueDescription(
  account: Account,
  customerId: string,
  description: JsonValue | undefined,
): string {
  if (!IsJsonString(description) || !description) {
    throw Unprocessable("The description is missing", "description");
  }
  const isTaken = [...account.subscriptions.values()].some(
    (subscription) =>
      subscription.customerId === customerId &&
      subscription.status !== "canceled" &&
      subscription.description === description,
  );
  if (isTaken) {
    throw Unprocessable(
      "The description must be unique for the customer's active subscriptions",
      "description",
    );
  }
  return description;
}

function SubscriptionOf(
  account: Account,
  customerId: string,
  id: string,
): MollieSubscription {
  CustomerOf(account, customerId);
  const subscription = account.subscriptions.get(id);
  if (!subscription || subscription.customerId !== customerId) {
    throw NotFound("subscription", id);
  }
  return subscription;
}

export function CreateSubscription(request: Request): StandInResponse {
  const { account, body } = request;
  const customerId = request.params[0];
  CustomerOf(account, customerId);
  const mandate = body.mandateId
    ? MandateOf(account, customerId, Text(body.mandateId))
    : [...account.mandates.values()].find(
        (candidate) =>
          candidate.customerId === customerId && candidate.status === "valid",
      );
  if (mandate?.status !== "valid")
    throw Unprocessable("The customer has no valid mandate", "mandateId");
  AssertWebhookUrl(body.webhookUrl);
  const startDate = readStartDate(body.startDate);
  const subscription: MollieSubscription = {
    resource: "subscription",
    id: NewId("sub"),
    status: "active",
    amount: ReadAmount(body.amount, "amount"),
    times: CountOf(body.times) ?? null,
    timesRemaining: CountOf(body.times) ?? null,
    interval: readInterval(body.interval),
    startDate,
    nextPaymentDate: startDate,
    description: assertUniqueDescription(account, customerId, body.description),
    metadata: body.metadata ?? null,
    webhookUrl: TextOf(body.webhookUrl) ?? null,
    customerId,
    mandateId: mandate.id,
    createdAt: NowIso(),
  };
  account.subscriptions.set(subscription.id, subscription);
  return Ok(subscription, 201);
}

export function GetSubscription(request: Request): StandInResponse {
  return Ok(
    SubscriptionOf(request.account, request.params[0], request.params[1]),
  );
}

export function ListSubscriptions(request: Request): StandInResponse {
  const customerId = request.params[0];
  CustomerOf(request.account, customerId);
  const owned = [...request.account.subscriptions.values()].filter(
    (subscription) => subscription.customerId === customerId,
  );
  return Page(
    owned,
    request.query,
    "subscriptions",
    `${request.hooks.baseUrl}/v2/customers/${customerId}/subscriptions`,
  );
}

export function UpdateSubscription(request: Request): StandInResponse {
  const [customerId, id] = request.params;
  const subscription = SubscriptionOf(request.account, customerId, id);
  if (subscription.status === "canceled") {
    throw Unprocessable("Canceled subscriptions cannot be updated");
  }
  if ("mandateId" in request.body) {
    MandateOf(request.account, customerId, Text(request.body.mandateId));
  }
  for (const field of UPDATABLE) {
    if (field in request.body)
      Object.assign(subscription, { [field]: request.body[field] });
  }
  return Ok(subscription);
}

export function CancelSubscription(request: Request): StandInResponse {
  const subscription = SubscriptionOf(
    request.account,
    request.params[0],
    request.params[1],
  );
  if (subscription.status === "canceled") {
    throw Unprocessable("The subscription has been canceled already");
  }
  CancelSubscriptionRecord(subscription);
  return Ok(subscription);
}

export function ListSubscriptionPayments(request: Request): StandInResponse {
  const [customerId, id] = request.params;
  SubscriptionOf(request.account, customerId, id);
  const spawned = [...request.account.payments.values()].filter(
    (payment) => payment.subscriptionId === id,
  );
  return Page(
    spawned,
    request.query,
    "payments",
    `${request.hooks.baseUrl}/v2/customers/${customerId}/subscriptions/${id}/payments`,
  );
}

function advance(date: string, interval: string): string {
  const match = INTERVAL.exec(interval);
  const count = Number(match?.[1] ?? 1);
  const unit = match?.[2].replace(/s$/, "") ?? "month";
  const [year, month, day] = date.split("-").map(Number);
  const moved =
    unit === "month"
      ? new Date(
          Date.UTC(
            year,
            month - 1 + count,
            Math.min(
              day,
              new Date(Date.UTC(year, month + count, 0)).getUTCDate(),
            ),
          ),
        )
      : new Date(
          Date.UTC(
            year,
            month - 1,
            day + count * (unit === "week" ? DAYS_PER_WEEK : 1),
          ),
        );
  return moved.toISOString().slice(0, 10);
}

export function RenewSubscription(
  account: Account,
  hooks: PaymentHooks,
  subscription: MollieSubscription,
): MolliePayment {
  if (subscription.status !== "active" || !subscription.nextPaymentDate) {
    throw new Error(
      `Subscription ${subscription.id} is ${subscription.status} and fires nothing`,
    );
  }
  const mandate = account.mandates.get(subscription.mandateId ?? "");
  const token = NewId("tkn");
  const payment: MolliePayment = {
    resource: "payment",
    id: NewId("tr"),
    mode: "test",
    description: subscription.description,
    amount: { ...subscription.amount },
    status: "open",
    sequenceType: "recurring",
    method: mandate?.method ?? "creditcard",
    metadata: subscription.metadata ?? null,
    customerId: subscription.customerId,
    mandateId: subscription.mandateId ?? null,
    subscriptionId: subscription.id,
    webhookUrl: subscription.webhookUrl ?? null,
    createdAt: NowIso(),
    isCancelable: true,
    _links: {},
  };
  payment._links = PaymentLinks(hooks, payment, token, payment.method);
  account.tokens.set(token, payment.id);
  account.payments.set(payment.id, payment);
  subscription.nextPaymentDate = advance(
    subscription.nextPaymentDate,
    subscription.interval,
  );
  return payment;
}
