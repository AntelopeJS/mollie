import { DefinedFields, Lookup } from "../../mollie/fields";
import { NotFound, Unprocessable } from "./responses";
import { IsJsonObject } from "../../mollie/metadata";
import {
  type Account,
  IsString,
  IsoIn,
  NewId,
  NowIso,
  Text,
  TextOf,
} from "./state";
import type {
  JsonObject,
  JsonValue,
  MollieAmount,
  MollieMandate,
  MolliePayment,
  MolliePaymentStatus,
} from "../../mollie/types";

export interface PaymentHooks {
  baseUrl: string;
  notify(account: Account, payment: MolliePayment): void;
}

export type Body = JsonObject;

const CHECKOUT_LIFETIME_MS = 15 * 60 * 1000;
const AUTHORIZATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MANUAL_CAPTURE = new Set([
  "billie",
  "billink",
  "creditcard",
  "klarna",
  "mobilepay",
  "paypal",
  "riverty",
  "vipps",
]);
const ZERO_DECIMALS = new Set(["ISK", "JPY"]);
const SEQUENCE_TYPES: MolliePayment["sequenceType"][] = [
  "oneoff",
  "first",
  "recurring",
];
const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
const TEST_CARD = {
  cardHolder: "T. TEST",
  cardNumber: "9399",
  cardLabel: "Mastercard",
  cardFingerprint: "fp_conformance",
  cardExpiryDate: "2030-12-31",
};
const MAGIC_FAILURES = {
  "1001.00": "invalid_card_number",
  "1002.00": "invalid_cvv",
  "1003.00": "invalid_card_holder_name",
  "1004.00": "card_expired",
  "1005.00": "invalid_card_type",
  "1006.00": "refused_by_issuer",
  "1007.00": "insufficient_funds",
  "1008.00": "inactive_card",
  "1009.00": "possible_fraud",
  "1010.00": "authentication_failed",
  "1011.00": "card_declined",
} satisfies Record<string, string>;

export function ReadAmount(
  value: JsonValue | undefined,
  field: string,
): MollieAmount {
  const amount = IsJsonObject(value) ? value : undefined;
  const currency = TextOf(amount?.currency);
  const units = TextOf(amount?.value);
  const decimals = ZERO_DECIMALS.has(currency ?? "") ? 0 : 2;
  const pattern = decimals === 0 ? /^\d+$/ : /^\d+\.\d{2}$/;
  if (currency === undefined || units === undefined || !pattern.test(units)) {
    throw Unprocessable(
      `The amount contains an invalid value or the wrong number of decimals for ${currency ?? "undefined"}`,
      field,
    );
  }
  return { currency, value: units };
}

function link(href: string, type = "application/hal+json") {
  return { href, type };
}

export function AssertWebhookUrl(value: JsonValue | undefined): void {
  if (value === undefined || value === null) return;
  const host = URL.canParse(Text(value)) ? new URL(Text(value)).hostname : "";
  if (!host || LOCAL_HOSTS.test(host)) {
    throw Unprocessable(
      "The webhook URL is invalid because it is unreachable from Mollie's point of view",
      "webhookUrl",
    );
  }
}

function chargeableMandate(account: Account, body: Body): MollieMandate {
  const customerId = Text(body.customerId);
  if (!account.customers.has(customerId)) {
    throw Unprocessable(
      "A recurring payment needs an existing customer",
      "customerId",
    );
  }
  const mandate = body.mandateId
    ? account.mandates.get(Text(body.mandateId))
    : [...account.mandates.values()].find(
        (candidate) =>
          candidate.customerId === customerId && candidate.status === "valid",
      );
  if (
    !mandate ||
    mandate.customerId !== customerId ||
    mandate.status !== "valid"
  ) {
    throw Unprocessable(
      "The mandate is not valid for this customer",
      "mandateId",
    );
  }
  return mandate;
}

function assertCaptureMode(body: Body, method: JsonValue | undefined): void {
  if (body.captureMode !== "manual") return;
  const methods = Array.isArray(method) ? method : [method];
  if (method && !methods.every((entry) => MANUAL_CAPTURE.has(Text(entry)))) {
    throw Unprocessable(
      "This payment method does not support manual capture",
      "captureMode",
    );
  }
}

function checkoutLinks(
  hooks: PaymentHooks,
  token: string,
  method: JsonValue | undefined,
) {
  const preset = TextOf(method);
  return {
    checkout: link(
      preset
        ? `${hooks.baseUrl}/checkout/test-mode?method=${preset}&token=${token}`
        : `${hooks.baseUrl}/checkout/select-method/${token}`,
      "text/html",
    ),
  };
}

function recurringLinks(hooks: PaymentHooks, token: string, method: string) {
  return {
    changePaymentState: link(
      `${hooks.baseUrl}/checkout/test-mode?method=${method}&token=${token}`,
      "text/html",
    ),
  };
}

export function PaymentLinks(
  hooks: PaymentHooks,
  payment: MolliePayment,
  token: string,
  method: JsonValue | undefined,
) {
  const self = link(`${hooks.baseUrl}/v2/payments/${payment.id}`);
  const flow =
    payment.sequenceType === "recurring"
      ? recurringLinks(hooks, token, String(payment.method))
      : checkoutLinks(hooks, token, method);
  return { self, ...flow };
}

interface Draft {
  sequenceType: MolliePayment["sequenceType"];
  mandate?: MollieMandate;
}

function isSequenceType(
  value: JsonValue,
): value is MolliePayment["sequenceType"] {
  return SEQUENCE_TYPES.some((sequenceType) => sequenceType === value);
}

function draftOf(account: Account, body: Body): Draft {
  const sequenceType = body.sequenceType ?? "oneoff";
  if (!isSequenceType(sequenceType)) {
    throw Unprocessable("The sequence type is invalid", "sequenceType");
  }
  if (sequenceType === "recurring") {
    return { sequenceType, mandate: chargeableMandate(account, body) };
  }
  if (
    sequenceType === "first" &&
    !account.customers.has(Text(body.customerId))
  ) {
    throw Unprocessable(
      "A first payment needs an existing customer",
      "customerId",
    );
  }
  if (!IsString(body.redirectUrl)) {
    throw Unprocessable("The redirect URL is missing", "redirectUrl");
  }
  if (
    body.customerId !== undefined &&
    !account.customers.has(Text(body.customerId))
  ) {
    throw NotFound("customer", Text(body.customerId));
  }
  return { sequenceType };
}

export function CreatePaymentRecord(
  account: Account,
  hooks: PaymentHooks,
  body: Body,
): MolliePayment {
  const amount = ReadAmount(body.amount, "amount");
  if (!IsString(body.description)) {
    throw Unprocessable("The description is missing", "description");
  }
  AssertWebhookUrl(body.webhookUrl);
  const draft = draftOf(account, body);
  const method = draft.mandate?.method ?? body.method;
  assertCaptureMode(body, method);
  const token = NewId("tkn");
  const payment: MolliePayment = {
    resource: "payment",
    id: NewId("tr"),
    mode: "test",
    description: body.description,
    amount,
    status: "open",
    sequenceType: draft.sequenceType,
    method: TextOf(method) ?? null,
    metadata: body.metadata ?? null,
    customerId: draft.mandate?.customerId ?? TextOf(body.customerId) ?? null,
    mandateId: draft.mandate?.id ?? null,
    redirectUrl: TextOf(body.redirectUrl) ?? null,
    webhookUrl: TextOf(body.webhookUrl) ?? null,
    createdAt: NowIso(),
    isCancelable: true,
    _links: {},
    ...DefinedFields({
      captureMode:
        body.captureMode === "manual" ? ("manual" as const) : undefined,
      expiresAt:
        draft.sequenceType === "recurring"
          ? undefined
          : IsoIn(CHECKOUT_LIFETIME_MS),
    }),
  };
  payment._links = PaymentLinks(hooks, payment, token, method);
  account.tokens.set(token, payment.id);
  account.payments.set(payment.id, payment);
  if (draft.mandate && account.declinesAtCreation.has(draft.mandate.id)) {
    declineAtOnce(payment);
  }
  return payment;
}

function declineAtOnce(payment: MolliePayment): void {
  payment.status = "failed";
  payment.failedAt = NowIso();
  payment.isCancelable = undefined;
  payment.details = {
    failureReason: "card_declined",
    failureMessage: "The card was declined",
  };
  payment._links = { self: payment._links.self };
}

export function PaymentOf(account: Account, id: string): MolliePayment {
  const payment = account.payments.get(id);
  if (!payment) throw NotFound("payment", id);
  return payment;
}

function createMandate(
  account: Account,
  payment: MolliePayment,
  method: string,
): void {
  const mandate: MollieMandate = {
    resource: "mandate",
    id: NewId("mdt"),
    method: method as MollieMandate["method"],
    status: "valid",
    scopes: ["customer-not-present", "customer-present"],
    details:
      method === "creditcard"
        ? { ...TEST_CARD }
        : { consumerAccount: "NL55INGB0000000000" },
    customerId: payment.customerId ?? "",
    createdAt: NowIso(),
  };
  account.mandates.set(mandate.id, mandate);
  payment.mandateId = mandate.id;
}

type Transition = (account: Account, payment: MolliePayment) => void;

const TRANSITIONS: Partial<Record<MolliePaymentStatus, Transition>> = {
  authorized: (_account, payment) => {
    Object.assign(payment, {
      authorizedAt: NowIso(),
      captureBefore: IsoIn(AUTHORIZATION_LIFETIME_MS),
      amountCaptured: {
        currency: payment.amount.currency,
        value: zero(payment.amount),
      },
    });
  },
  canceled: (_account, payment) => {
    payment.canceledAt = NowIso();
  },
  expired: (_account, payment) => {
    payment.expiredAt = NowIso();
  },
  failed: (_account, payment) => {
    payment.failedAt = NowIso();
    const reason =
      payment.method === "creditcard"
        ? Lookup(MAGIC_FAILURES, payment.amount.value)
        : undefined;
    if (reason)
      payment.details = {
        failureReason: reason,
        failureMessage: `The payment failed: ${reason}`,
      };
  },
  paid: (account, payment) => {
    payment.paidAt = NowIso();
    Object.assign(payment, {
      amountRefunded: {
        currency: payment.amount.currency,
        value: zero(payment.amount),
      },
      amountRemaining: { ...payment.amount },
    });
    if (payment.sequenceType === "first")
      createMandate(account, payment, payment.method ?? "creditcard");
  },
};

export function zero(amount: MollieAmount): string {
  return ZERO_DECIMALS.has(amount.currency) ? "0" : "0.00";
}

export function Transition(
  account: Account,
  hooks: PaymentHooks,
  payment: MolliePayment,
  status: MolliePaymentStatus,
): void {
  const apply = TRANSITIONS[status];
  if (payment.status !== "open" || !apply) {
    throw Unprocessable(
      `The payment cannot go from ${payment.status} to ${status}`,
    );
  }
  if (status === "authorized" && payment.captureMode !== "manual") {
    throw Unprocessable("Only a manual-capture payment can be authorized");
  }
  payment.status = status;
  payment.isCancelable = undefined;
  apply(account, payment);
  const { self } = payment._links;
  payment._links = { self };
  hooks.notify(account, payment);
}
