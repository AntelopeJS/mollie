import { IsMolliePayment } from "../../mollie/resources";
import {
  type CheckoutSession,
  type CheckoutSessionRequest,
  PaymentError,
  type PaymentLocale,
} from "@antelopejs/interface-payment";

import { TranslatingNamed } from "./errors";
import { ReadPayment } from "./payments";
import { GetAccount } from "../../accounts";
import { DefinedFields, Lookup } from "../../mollie/fields";
import { ToMollieAmount } from "../../mollie/amounts";
import { WriteMetadata } from "../../mollie/metadata";
import { MANUAL_CAPTURE_METHODS } from "./instruments";
import type { MolliePayment } from "../../mollie/types";
import { CheckoutUrl, ToEpochMillis, ToPaymentStatus } from "./mapping";

const SESSION_ENTITY = "checkout session";

const MOLLIE_LOCALES = new Set([
  "ca_ES",
  "cs_CZ",
  "da_DK",
  "de_AT",
  "de_CH",
  "de_DE",
  "de_LU",
  "el_GR",
  "en_BE",
  "en_GB",
  "en_NL",
  "en_US",
  "es_ES",
  "fi_FI",
  "fr_BE",
  "fr_FR",
  "fr_LU",
  "hu_HU",
  "is_IS",
  "it_IT",
  "lt_LT",
  "lv_LV",
  "nb_NO",
  "nl_BE",
  "nl_NL",
  "pl_PL",
  "pt_PT",
  "sk_SK",
  "sl_SI",
  "sv_SE",
  "tr_TR",
]);

/** The region Mollie shows each language in when the request names none it offers. */
const MOLLIE_LOCALE_BY_LANGUAGE = {
  cs: "cs_CZ",
  da: "da_DK",
  de: "de_DE",
  el: "el_GR",
  en: "en_US",
  es: "es_ES",
  fi: "fi_FI",
  fr: "fr_FR",
  hu: "hu_HU",
  it: "it_IT",
  lt: "lt_LT",
  lv: "lv_LV",
  nb: "nb_NO",
  nl: "nl_NL",
  pl: "pl_PL",
  pt: "pt_PT",
  sk: "sk_SK",
  sl: "sl_SI",
  sv: "sv_SE",
  tr: "tr_TR",
};

function toMollieLocale(locale?: PaymentLocale): string | undefined {
  if (!locale) return undefined;
  const candidate = locale.replace("-", "_");
  if (MOLLIE_LOCALES.has(candidate)) return candidate;
  return Lookup(MOLLIE_LOCALE_BY_LANGUAGE, locale.split("-")[0]);
}

function toSession(payment: MolliePayment): CheckoutSession {
  const redirectUrl = CheckoutUrl(payment);
  return {
    id: payment.id,
    redirectUrl: redirectUrl ?? "",
    status: ToPaymentStatus(payment),
    payment: payment.id,
    ...DefinedFields({
      expiresAt: payment.expiresAt
        ? ToEpochMillis(payment.expiresAt)
        : undefined,
    }),
  };
}

function sessionBody(request: CheckoutSessionRequest) {
  const locale = toMollieLocale(request.locale);
  return {
    amount: ToMollieAmount(request.amount),
    description: request.description ?? request.reference,
    redirectUrl: request.successUrl,
    cancelUrl: request.cancelUrl,
    sequenceType: request.savePaymentMethod ? "first" : "oneoff",
    metadata: WriteMetadata({ reference: request.reference }, request.metadata),
    ...DefinedFields({
      customerId: request.customer,
      captureMode: request.authorizeOnly ? "manual" : undefined,
      method: request.authorizeOnly ? MANUAL_CAPTURE_METHODS : undefined,
      locale,
    }),
  };
}

export async function CreateCheckoutSession(
  request: CheckoutSessionRequest,
  idempotencyKey: string,
  provider?: string,
): Promise<CheckoutSession> {
  if (request.savePaymentMethod && !request.customer) {
    throw new PaymentError("savePaymentMethod requires a customer");
  }
  const account = GetAccount(provider);
  const body = sessionBody(request);
  return TranslatingNamed({ customer: request.customer }, async () =>
    toSession(
      await account.client.request(
        {
          method: "POST",
          path: "/payments",
          body: {
            ...body,
            ...DefinedFields({ webhookUrl: account.webhookUrl }),
          },
          idempotencyKey,
        },
        IsMolliePayment,
      ),
    ),
  );
}

export async function GetCheckoutSession(
  id: string,
  provider?: string,
): Promise<CheckoutSession> {
  return toSession(await ReadPayment(GetAccount(provider), id, SESSION_ENTITY));
}
