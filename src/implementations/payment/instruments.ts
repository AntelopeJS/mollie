import { IsMollieMandate } from "../../mollie/resources";
import {
  PaymentError,
  type PaymentRequest,
} from "@antelopejs/interface-payment";

import type { Account } from "../../accounts";
import { NotFound, Translating } from "./errors";
import { ParsePaymentMethodId } from "../../mollie/ids";

const MOLLIE_METHODS = new Set([
  "alma",
  "applepay",
  "bacs",
  "bancomatpay",
  "bancontact",
  "banktransfer",
  "belfius",
  "billie",
  "billink",
  "bizum",
  "blik",
  "creditcard",
  "directdebit",
  "eps",
  "giftcard",
  "ideal",
  "in3",
  "kbc",
  "klarna",
  "klarnapaylater",
  "klarnapaynow",
  "klarnasliceit",
  "mbway",
  "mobilepay",
  "multibanco",
  "mybank",
  "payconiq",
  "paybybank",
  "paypal",
  "paysafecard",
  "pointofsale",
  "przelewy24",
  "riverty",
  "satispay",
  "swish",
  "trustly",
  "twint",
  "vipps",
  "voucher",
  "wero",
]);

export const MANUAL_CAPTURE_METHODS = [
  "creditcard",
  "klarna",
  "billie",
  "riverty",
  "vipps",
  "mobilepay",
  "paypal",
  "billink",
];

const MANUAL_CAPTURE_MANDATES = new Set(["creditcard", "paypal"]);
const CARD_TOKEN = /^tkn_[A-Za-z0-9]+$/;
const CARD_METHOD = "creditcard";

interface MandateInstrument {
  kind: "mandate";
  customerId: string;
  mandateId: string;
  fields: Record<string, string>;
}

interface OnSessionInstrument {
  kind: "cardToken" | "hosted" | "method";
  method?: string;
  fields: Record<string, string>;
}

export type Instrument = MandateInstrument | OnSessionInstrument;

export function ResolveInstrument(paymentMethod?: string): Instrument {
  if (!paymentMethod) {
    return { kind: "hosted", fields: {} };
  }
  const saved = ParsePaymentMethodId(paymentMethod);
  if (saved) {
    return {
      kind: "mandate",
      customerId: saved.parent,
      mandateId: saved.child,
      fields: { customerId: saved.parent, mandateId: saved.child },
    };
  }
  if (CARD_TOKEN.test(paymentMethod)) {
    return {
      kind: "cardToken",
      method: CARD_METHOD,
      fields: { method: CARD_METHOD, cardToken: paymentMethod },
    };
  }
  if (MOLLIE_METHODS.has(paymentMethod)) {
    return {
      kind: "method",
      method: paymentMethod,
      fields: { method: paymentMethod },
    };
  }
  throw NotFound(paymentMethod, "payment method");
}

export function AssertConsistent(
  request: PaymentRequest,
  instrument: Instrument,
): void {
  if (request.savePaymentMethod && request.offSession) {
    throw new PaymentError(
      "savePaymentMethod cannot be combined with offSession: a mandate can only be taken from a payer who is present",
    );
  }
  if (request.savePaymentMethod && !request.customer) {
    throw new PaymentError("savePaymentMethod requires a customer");
  }
  if (request.offSession && instrument.kind !== "mandate") {
    throw new PaymentError(
      "An off-session payment needs a saved paymentMethod to charge",
    );
  }
  if (instrument.kind !== "mandate" && !request.returnUrl) {
    throw new PaymentError(
      "returnUrl is required: Mollie sends every payer-present payment through a redirect",
    );
  }
  const isOtherCustomer =
    instrument.kind === "mandate" &&
    request.customer !== undefined &&
    request.customer !== instrument.customerId;
  if (isOtherCustomer) {
    throw NotFound(request.paymentMethod ?? "", "payment method");
  }
}

async function mandateMethod(
  account: Account,
  instrument: MandateInstrument,
  paymentMethod: string,
): Promise<string> {
  const mandate = await Translating(paymentMethod, "payment method", () =>
    account.client.request(
      {
        method: "GET",
        path: `/customers/${instrument.customerId}/mandates/${instrument.mandateId}`,
      },
      IsMollieMandate,
    ),
  );
  return mandate.method;
}

function refuseManualCapture(method: string): never {
  throw new PaymentError(
    `Mollie cannot hold a ${method} payment for later capture; authorizeOnly needs one of: ${MANUAL_CAPTURE_METHODS.join(", ")}`,
  );
}

export async function AssertCapturable(
  account: Account,
  instrument: Instrument,
  paymentMethod: string,
): Promise<void> {
  if (instrument.kind === "mandate") {
    const method = await mandateMethod(account, instrument, paymentMethod);
    if (!MANUAL_CAPTURE_MANDATES.has(method)) refuseManualCapture(method);
    return;
  }
  if (
    instrument.method &&
    !MANUAL_CAPTURE_METHODS.includes(instrument.method)
  ) {
    refuseManualCapture(instrument.method);
  }
}
