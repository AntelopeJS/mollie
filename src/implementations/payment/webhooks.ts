import {
  type PaymentEvent,
  type PaymentEventType,
  PaymentNotFoundError,
  WebhookVerificationError,
  type WebhookRequest,
} from "@antelopejs/interface-payment";

import { Translating } from "./errors";
import { ToEpochMillis } from "./mapping";
import { IsMollieId } from "../../mollie/ids";
import { type Account, GetAccount } from "../../accounts";
import { DispatchChargeEvents } from "../subscriptions/events";
import { MarkSubscriptionCharge, ReadPayment } from "./payments";
import type { MolliePayment, MolliePaymentStatus } from "../../mollie/types";

const ID_FIELD = "id";

const EVENT_BY_STATUS: Partial<Record<MolliePaymentStatus, PaymentEventType>> =
  {
    authorized: "payment.authorized",
    canceled: "payment.canceled",
    expired: "payment.canceled",
    failed: "payment.failed",
    paid: "payment.succeeded",
    pending: "payment.pending",
  };

type StatusTime = (payment: MolliePayment) => string | null | undefined;

const STATUS_TIME: Record<MolliePaymentStatus, StatusTime> = {
  authorized: (payment) => payment.authorizedAt,
  canceled: (payment) => payment.canceledAt,
  expired: (payment) => payment.expiredAt,
  failed: (payment) => payment.failedAt,
  open: (payment) => payment.createdAt,
  paid: (payment) => payment.paidAt,
  pending: (payment) => payment.createdAt,
};

function namedPayment(request: WebhookRequest): string {
  const body = Buffer.from(request.body).toString("utf8");
  const id = new URLSearchParams(body).get(ID_FIELD) ?? "";
  if (!IsMollieId("payment", id)) {
    throw new WebhookVerificationError(
      "The delivery does not name a Mollie payment; Mollie posts id=tr_… and nothing else",
    );
  }
  return id;
}

async function confirmedPayment(
  account: Account,
  id: string,
): Promise<MolliePayment> {
  try {
    return await ReadPayment(account, id);
  } catch (error) {
    if (error instanceof PaymentNotFoundError) {
      throw new WebhookVerificationError(
        `Mollie has no payment ${id} on this account`,
        error.providerCode,
      );
    }
    throw error;
  }
}

async function buildEvent(
  account: Account,
  payment: MolliePayment,
): Promise<PaymentEvent | undefined> {
  const type = EVENT_BY_STATUS[payment.status];
  if (!type) return undefined;
  const at = STATUS_TIME[payment.status](payment) ?? payment.createdAt;
  return {
    id: `${payment.id}:${payment.status}`,
    type,
    createdAt: ToEpochMillis(at),
    payment: await MarkSubscriptionCharge(account, payment),
  };
}

export async function VerifyWebhook(
  request: WebhookRequest,
  provider?: string,
): Promise<PaymentEvent | undefined> {
  const account = GetAccount(provider);
  const payment = await confirmedPayment(account, namedPayment(request));
  return Translating(payment.id, "payment", async () => {
    await DispatchChargeEvents(account, payment);
    return buildEvent(account, payment);
  });
}
