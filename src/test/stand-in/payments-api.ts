import { NotFound, Ok, Unprocessable } from "./responses";
import type {
  MollieAmount,
  MolliePayment,
  MollieRefund,
} from "../../mollie/types";
import {
  type Body,
  CreatePaymentRecord,
  type PaymentHooks,
  PaymentOf,
  ReadAmount,
  zero,
} from "./payments";
import {
  type Account,
  type Capture,
  NewId,
  Text,
  NewestFirst,
  NowIso,
  type StandInResponse,
} from "./state";

export interface Request {
  account: Account;
  hooks: PaymentHooks;
  params: string[];
  query: URLSearchParams;
  body: Body;
}

const MINOR_DECIMALS = 2;
const DECIMAL_BASE = 10;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 250;

function minor(value: string): number {
  return Number.parseInt(value.replace(".", ""), DECIMAL_BASE);
}

function format(units: number, template: string): string {
  if (!template.includes(".")) return String(units);
  const digits = String(units).padStart(MINOR_DECIMALS + 1, "0");
  return `${digits.slice(0, -MINOR_DECIMALS)}.${digits.slice(-MINOR_DECIMALS)}`;
}

interface Listed {
  id: string;
  createdAt: string;
}

export function Page<T extends Listed>(
  items: Iterable<T>,
  query: URLSearchParams,
  resource: string,
  baseUrl: string,
): StandInResponse {
  const limit = Math.min(Number(query.get("limit") ?? DEFAULT_PAGE), MAX_PAGE);
  const sorted = NewestFirst(items);
  const from = query.get("from");
  const start = from
    ? Math.max(
        sorted.findIndex((item) => item.id === from),
        0,
      )
    : 0;
  const page = sorted.slice(start, start + limit);
  const following = sorted[start + limit];
  return Ok({
    count: page.length,
    _embedded: { [resource]: page },
    _links: {
      next: following
        ? {
            href: `${baseUrl}?from=${following.id}&limit=${limit}`,
            type: "application/hal+json",
          }
        : null,
    },
  });
}

export function CreatePayment(request: Request): StandInResponse {
  return Ok(
    CreatePaymentRecord(request.account, request.hooks, request.body),
    201,
  );
}

export function GetPayment(request: Request): StandInResponse {
  return Ok(PaymentOf(request.account, request.params[0]));
}

export function ListPayments(request: Request): StandInResponse {
  return Page(
    request.account.payments.values(),
    request.query,
    "payments",
    `${request.hooks.baseUrl}/v2/payments`,
  );
}

export function CancelPayment(request: Request): StandInResponse {
  const payment = PaymentOf(request.account, request.params[0]);
  if (payment.status !== "open" || !payment.isCancelable) {
    throw Unprocessable("The payment cannot be canceled");
  }
  payment.status = "canceled";
  payment.canceledAt = NowIso();
  payment.isCancelable = undefined;
  payment._links = { self: payment._links.self };
  request.hooks.notify(request.account, payment);
  return Ok(payment);
}

function settleCapture(payment: MolliePayment, captured: string): void {
  payment.status = "paid";
  payment.paidAt = NowIso();
  Object.assign(payment, {
    amountCaptured: { currency: payment.amount.currency, value: captured },
    amountRefunded: {
      currency: payment.amount.currency,
      value: zero(payment.amount),
    },
    amountRemaining: { currency: payment.amount.currency, value: captured },
  });
}

export function CreateCapture(request: Request): StandInResponse {
  const payment = PaymentOf(request.account, request.params[0]);
  if (payment.status !== "authorized") {
    throw Unprocessable("The payment is not authorized", "paymentId");
  }
  const amount = request.body.amount
    ? ReadAmount(request.body.amount, "amount")
    : payment.amount;
  if (minor(amount.value) > minor(payment.amount.value)) {
    throw Unprocessable(
      "The capture amount is higher than the authorized amount",
      "amount",
    );
  }
  settleCapture(payment, amount.value);
  const capture: Capture = {
    resource: "capture",
    id: NewId("cpt"),
    mode: "test",
    amount,
    status: "succeeded",
    paymentId: payment.id,
    metadata: request.body.metadata ?? null,
    createdAt: NowIso(),
  };
  request.account.captures.set(capture.id, capture);
  request.hooks.notify(request.account, payment);
  return Ok(capture, 201);
}

export function ListCaptures(request: Request): StandInResponse {
  const paymentId = request.params[0];
  PaymentOf(request.account, paymentId);
  const captures = [...request.account.captures.values()].filter(
    (capture) => capture.paymentId === paymentId,
  );
  return Page(
    captures,
    request.query,
    "captures",
    `${request.hooks.baseUrl}/v2/payments/${paymentId}/captures`,
  );
}

export function ListRefunds(request: Request): StandInResponse {
  const paymentId = request.params[0];
  PaymentOf(request.account, paymentId);
  const refunds = [...request.account.refunds.values()].filter(
    (refund) => refund.paymentId === paymentId,
  );
  return Page(
    refunds,
    request.query,
    "refunds",
    `${request.hooks.baseUrl}/v2/payments/${paymentId}/refunds`,
  );
}

export function ReleaseAuthorization(request: Request): StandInResponse {
  const payment = PaymentOf(request.account, request.params[0]);
  if (payment.status !== "authorized") {
    throw Unprocessable(
      "You are trying to release a payment that is not authorized",
    );
  }
  payment.status = "canceled";
  payment.canceledAt = NowIso();
  request.hooks.notify(request.account, payment);
  return { status: 202 };
}

function refundable(payment: MolliePayment, amount: MollieAmount): void {
  if (payment.status !== "paid") {
    throw Unprocessable("The payment cannot be refunded", "paymentId");
  }
  const remaining = payment.amountRemaining ?? payment.amount;
  if (
    amount.currency !== remaining.currency ||
    minor(amount.value) > minor(remaining.value)
  ) {
    throw Unprocessable(
      "The amount is higher than the remaining amount",
      "amount",
    );
  }
}

function adjust(payment: MolliePayment, refunded: string): void {
  const refundedUnits = minor(refunded);
  const total = minor(payment.amountRefunded?.value ?? "0") + refundedUnits;
  const left =
    minor((payment.amountRemaining ?? payment.amount).value) - refundedUnits;
  payment.amountRefunded = {
    currency: payment.amount.currency,
    value: format(total, payment.amount.value),
  };
  payment.amountRemaining = {
    currency: payment.amount.currency,
    value: format(left, payment.amount.value),
  };
}

export function CreateRefund(request: Request): StandInResponse {
  const payment = PaymentOf(request.account, request.params[0]);
  const amount = ReadAmount(request.body.amount, "amount");
  refundable(payment, amount);
  const refund: MollieRefund = {
    resource: "refund",
    id: NewId("re"),
    amount,
    status: "pending",
    paymentId: payment.id,
    description: Text(request.body.description),
    metadata: request.body.metadata ?? null,
    createdAt: NowIso(),
  };
  adjust(payment, amount.value);
  request.account.refunds.set(refund.id, refund);
  return Ok(refund, 201);
}

export function GetRefund(request: Request): StandInResponse {
  const [paymentId, refundId] = request.params;
  PaymentOf(request.account, paymentId);
  const refund = request.account.refunds.get(refundId);
  if (!refund || refund.paymentId !== paymentId)
    throw NotFound("refund", refundId);
  return Ok(refund);
}
