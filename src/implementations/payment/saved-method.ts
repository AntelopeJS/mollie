import { setTimeout as delay } from "node:timers/promises";

import type { Account } from "../../accounts";
import { IsMollieMandate } from "../../mollie/resources";
import type { MolliePayment } from "../../mollie/types";
import { ToEpochMillis } from "./mapping";

/**
 * How long after a first card payment is paid the module waits for its mandate
 * to turn valid. Mollie's test mode took 250 to 570 ms in three trials, so this
 * is about nine times the slowest.
 */
export const MANDATE_WAIT_MS = 5_000;
const MANDATE_POLL_MS = 250;
const CARD = "creditcard";

interface SavedCard {
  customerId: string;
  mandateId: string;
}

function savedCardOf(payment: MolliePayment): SavedCard | undefined {
  const { customerId, mandateId } = payment;
  const isSavingCard =
    payment.status === "paid" &&
    payment.sequenceType === "first" &&
    payment.method === CARD;
  return isSavingCard && customerId && mandateId
    ? { customerId, mandateId }
    : undefined;
}

async function isPending(account: Account, card: SavedCard): Promise<boolean> {
  try {
    const mandate = await account.client.request(
      {
        method: "GET",
        path: `/customers/${card.customerId}/mandates/${card.mandateId}`,
      },
      IsMollieMandate,
    );
    return mandate.status === "pending";
  } catch {
    return false;
  }
}

/**
 * Returns once the card a paid `first` payment saved is listable, or once
 * {@link MANDATE_WAIT_MS} have passed since the payment was paid, whichever
 * comes first. Mollie reports such a payment paid a few hundred milliseconds
 * before it turns the mandate from `pending` to `valid`, and
 * `ListPaymentMethods` lists only valid mandates. Waiting is bounded from the
 * payment's own `paidAt`, so a mandate that stays pending delays the payment's
 * reads once, not on every call. Only cards wait: a bank mandate can stay
 * pending for days, and an unreadable mandate does not hold the payment back.
 */
export async function AwaitSavedMethod(
  account: Account,
  payment: MolliePayment,
): Promise<void> {
  const card = savedCardOf(payment);
  if (!card) return;
  const paidAt = payment.paidAt ? ToEpochMillis(payment.paidAt) : Date.now();
  const deadline = Math.min(Date.now(), paidAt) + MANDATE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await isPending(account, card))) return;
    await delay(Math.min(MANDATE_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}
