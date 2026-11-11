import type {
  CardDetails,
  Payment,
  PaymentFailure,
  PaymentFailureCode,
  PaymentMethod,
  PaymentMethodType,
  PaymentStatus,
  Refund,
  RefundStatus,
} from "@antelopejs/interface-payment";

import { PaymentMethodId, RefundId } from "../../mollie/ids";
import { DefinedFields, Lookup, NonEmpty } from "../../mollie/fields";
import { FromMollieAmount, ZeroAmount } from "../../mollie/amounts";
import { IsText } from "../../mollie/guards";
import {
  type OwnFields,
  ReadCallerMetadata,
  ReadOwn,
} from "../../mollie/metadata";
import type {
  MollieCapture,
  MollieMandate,
  MolliePayment,
  MolliePaymentStatus,
  MollieRefund,
  MollieRefundStatus,
} from "../../mollie/types";

interface OwnPaymentData {
  reference: string;
  subscription: string;
}

const OWN_PAYMENT: OwnFields<OwnPaymentData> = {
  reference: IsText,
  subscription: IsText,
};

const CHECKOUT_LINK = "checkout";
const OFF_SESSION_SCOPE = "customer-not-present";

const STATUS_BY_MOLLIE: Record<MolliePaymentStatus, PaymentStatus> = {
  authorized: "authorized",
  canceled: "canceled",
  expired: "canceled",
  failed: "failed",
  open: "pending",
  paid: "succeeded",
  pending: "pending",
};

const FAILURE_BY_REASON = {
  authentication_abandoned: "authentication_failed",
  authentication_failed: "authentication_failed",
  authentication_required: "authentication_failed",
  authentication_unavailable_acs: "authentication_failed",
  card_declined: "declined",
  card_expired: "expired_card",
  inactive_card: "declined",
  insufficient_funds: "insufficient_funds",
  invalid_card_holder_name: "incorrect_details",
  invalid_card_number: "incorrect_details",
  invalid_card_type: "declined",
  invalid_cvv: "incorrect_details",
  possible_fraud: "declined",
  refused_by_issuer: "declined",
  unknown_reason: "declined",
} satisfies Record<string, PaymentFailureCode>;

const FAILURE_BY_BANK_REASON = {
  AC01: "incorrect_details",
  AM04: "insufficient_funds",
} satisfies Record<string, PaymentFailureCode>;

const REFUND_STATUS_BY_MOLLIE: Record<MollieRefundStatus, RefundStatus> = {
  canceled: "failed",
  failed: "failed",
  pending: "pending",
  processing: "pending",
  queued: "pending",
  refunded: "succeeded",
};

const METHOD_TYPE_BY_MANDATE: Record<
  MollieMandate["method"],
  PaymentMethodType
> = {
  creditcard: "card",
  directdebit: "bank_account",
  paypal: "wallet",
};

const CARD_NUMBER_TAIL = 4;
const EXPIRY_DATE = /^(\d{4})-(\d{2})/;
const BASE = 10;

export function ToEpochMillis(isoTime: string): number {
  return Date.parse(isoTime);
}

export function CheckoutUrl(payment: MolliePayment): string | undefined {
  return payment.status === "open"
    ? (payment._links[CHECKOUT_LINK]?.href ?? undefined)
    : undefined;
}

/**
 * The capture Mollie has accepted for an authorized payment but not applied to
 * it yet. Mollie keeps the payment `authorized`, with nothing captured, until
 * it processes the capture.
 */
function inFlight(
  payment: MolliePayment,
  capture: MollieCapture | undefined,
): MollieCapture | undefined {
  return payment.status === "authorized" && capture?.status !== "failed"
    ? capture
    : undefined;
}

/**
 * The payment's status for the interface. `capture` is the payment's capture,
 * when the caller has read it: with one in flight the payment is `pending`.
 */
export function ToPaymentStatus(
  payment: MolliePayment,
  capture?: MollieCapture,
): PaymentStatus {
  if (CheckoutUrl(payment)) {
    return "requires_action";
  }
  if (inFlight(payment, capture)) return "pending";
  return STATUS_BY_MOLLIE[payment.status] ?? "pending";
}

function toFailure(payment: MolliePayment): PaymentFailure {
  const details = payment.details ?? {};
  const providerCode =
    details.failureReason ?? details.bankReasonCode ?? undefined;
  const code =
    Lookup(FAILURE_BY_REASON, details.failureReason ?? "") ??
    Lookup(FAILURE_BY_BANK_REASON, details.bankReasonCode ?? "") ??
    "declined";
  return {
    code,
    message:
      details.failureMessage ?? details.bankReason ?? "The payment failed",
    ...DefinedFields({ providerCode }),
  };
}

function capturedAmount(
  payment: MolliePayment,
  capture: MollieCapture | undefined,
): Payment["amountCaptured"] {
  const accepted = inFlight(payment, capture);
  if (accepted) {
    return FromMollieAmount(accepted.amount ?? payment.amount);
  }
  if (payment.amountCaptured) {
    return FromMollieAmount(payment.amountCaptured);
  }
  return payment.status === "paid"
    ? FromMollieAmount(payment.amount)
    : ZeroAmount(payment.amount.currency);
}

function savedMethod(payment: MolliePayment): string | undefined {
  return payment.customerId && payment.mandateId
    ? PaymentMethodId(payment.customerId, payment.mandateId)
    : undefined;
}

/**
 * Whether Mollie holds a refund of the payment. Mollie links `refunds` on a
 * payment from the first refund it creates, and on no payment before. Its
 * `amountRemaining` is no sign of a refund: test mode reports it above the
 * payment's amount on some paid payments.
 */
export function HasRefunds(payment: MolliePayment): boolean {
  return Boolean(payment._links.refunds);
}

/**
 * The total of the refunds Mollie reports `refunded`, the interface's
 * `succeeded` refunds. `Payment.amountRefunded` is "how much has been refunded
 * so far. Zero until a refund settles", so a `queued`, `pending`, `processing`,
 * `failed` or `canceled` refund is not counted. Mollie's own `amountRefunded`
 * is not read. It moves when a refund settles, but it can trail the refund's
 * status, and the sum of the settled refunds is the contract at every read.
 */
function refundedAmount(
  payment: MolliePayment,
  refunds: readonly MollieRefund[],
): Payment["amountRefunded"] {
  const value = refunds
    .filter((refund) => REFUND_STATUS_BY_MOLLIE[refund.status] === "succeeded")
    .reduce(
      (total, refund) => total + FromMollieAmount(refund.amount).value,
      0,
    );
  return { value, currency: ZeroAmount(payment.amount.currency).currency };
}

/**
 * The payment as the interface reports it. Pass the payment's capture when it
 * has been read, so that one Mollie has not applied yet shows, and its refunds
 * when it has any (`HasRefunds`), for the refunded amount.
 */
export function ToPayment(
  payment: MolliePayment,
  capture?: MollieCapture,
  refunds: readonly MollieRefund[] = [],
): Payment {
  const status = ToPaymentStatus(payment, capture);
  const metadata = ReadCallerMetadata(payment.metadata);
  const paymentMethod = savedMethod(payment);
  const redirectUrl = CheckoutUrl(payment);
  return {
    id: payment.id,
    amount: FromMollieAmount(payment.amount),
    amountCaptured: capturedAmount(payment, capture),
    amountRefunded: refundedAmount(payment, refunds),
    status,
    reference: ReadOwn(payment.metadata, OWN_PAYMENT)?.reference ?? "",
    createdAt: ToEpochMillis(payment.createdAt),
    ...DefinedFields({
      customer: payment.customerId ?? undefined,
      paymentMethod,
      redirectUrl,
      failure: status === "failed" ? toFailure(payment) : undefined,
      metadata: NonEmpty(metadata),
    }),
  };
}

function refundFailure(refund: MollieRefund): PaymentFailure {
  return {
    code: "processing_error",
    message: `The refund was ${refund.status}`,
    providerCode: refund.status,
  };
}

export function ToRefund(refund: MollieRefund): Refund {
  const status = REFUND_STATUS_BY_MOLLIE[refund.status] ?? "pending";
  return {
    id: RefundId(refund.paymentId, refund.id),
    payment: refund.paymentId,
    amount: FromMollieAmount(refund.amount),
    status,
    createdAt: ToEpochMillis(refund.createdAt),
    ...DefinedFields({
      failure: status === "failed" ? refundFailure(refund) : undefined,
      metadata: NonEmpty(ReadCallerMetadata(refund.metadata)),
    }),
  };
}

function toCard(mandate: MollieMandate): CardDetails | undefined {
  const details = mandate.details ?? {};
  const expiry = EXPIRY_DATE.exec(details.cardExpiryDate ?? "");
  if (mandate.method !== "creditcard" || !details.cardNumber || !expiry) {
    return undefined;
  }
  return {
    brand: details.cardLabel ?? "unknown",
    last4: details.cardNumber.slice(-CARD_NUMBER_TAIL),
    expiryMonth: Number.parseInt(expiry[2], BASE),
    expiryYear: Number.parseInt(expiry[1], BASE),
  };
}

export function ToPaymentMethod(
  mandate: MollieMandate,
  customerId: string,
): PaymentMethod {
  const card = toCard(mandate);
  return {
    id: PaymentMethodId(customerId, mandate.id),
    type: METHOD_TYPE_BY_MANDATE[mandate.method] ?? "other",
    customer: customerId,
    createdAt: ToEpochMillis(mandate.createdAt),
    ...DefinedFields({ card }),
  };
}

export function IsChargeableOffSession(mandate: MollieMandate): boolean {
  const isOffSession =
    !mandate.scopes || mandate.scopes.includes(OFF_SESSION_SCOPE);
  return mandate.status === "valid" && isOffSession;
}
