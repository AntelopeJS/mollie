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
export const MANDATE_POLL_MS = 250;
const REMEMBERED_PAYMENTS = 10_000;
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

/**
 * What one mandate read found: the mandate still `pending`, `settled` either
 * way, the read `failed`, or the read `cut` off at the deadline.
 */
type MandateRead = "pending" | "settled" | "failed" | "cut";

async function readMandate(
  account: Account,
  card: SavedCard,
  timeoutMs: number,
): Promise<MandateRead> {
  const deadline = AbortSignal.timeout(Math.max(1, timeoutMs));
  try {
    const mandate = await account.client.request(
      {
        method: "GET",
        path: `/customers/${card.customerId}/mandates/${card.mandateId}`,
        signal: deadline,
      },
      IsMollieMandate,
    );
    return mandate.status === "pending" ? "pending" : "settled";
  } catch {
    return deadline.aborted ? "cut" : "failed";
  }
}

/**
 * Whether the wait reached an answer: the mandate settled, or the budget ran
 * out after a read that succeeded or was cut off at the deadline. A failed read
 * is tried again at the next poll, because every caller sharing this wait would
 * otherwise stop with it.
 */
async function pollUntilListable(
  account: Account,
  card: SavedCard,
  deadline: number,
): Promise<boolean> {
  let last: MandateRead = "pending";
  for (let left = deadline - Date.now(); left > 0;) {
    last = await readMandate(account, card, left);
    if (last === "settled") return true;
    await delay(Math.min(MANDATE_POLL_MS, Math.max(0, deadline - Date.now())));
    left = deadline - Date.now();
  }
  return last !== "failed";
}

interface WaitLedger {
  running: Map<string, Promise<void>>;
  finished: Set<string>;
}

const LEDGERS = new WeakMap<Account, WaitLedger>();

function ledgerOf(account: Account): WaitLedger {
  const known = LEDGERS.get(account);
  if (known) return known;
  const created: WaitLedger = { running: new Map(), finished: new Set() };
  LEDGERS.set(account, created);
  return created;
}

function remember(finished: Set<string>, paymentId: string): void {
  finished.add(paymentId);
  if (finished.size <= REMEMBERED_PAYMENTS) return;
  const [oldest] = finished;
  if (oldest !== undefined) finished.delete(oldest);
}

/**
 * Returns once the card a paid `first` payment saved is listable, or once
 * {@link MANDATE_WAIT_MS} have passed since the payment was paid, whichever
 * comes first. Mollie reports such a payment paid a few hundred milliseconds
 * before it turns the mandate from `pending` to `valid`, and
 * `ListPaymentMethods` lists only valid mandates. Callers that wait on the same
 * payment share one wait, so the mandate is read about once per
 * {@link MANDATE_POLL_MS} however many of them there are. Each mandate read is
 * cut off at the deadline, so no call waits longer than the budget, and a read
 * cut short ends the wait. A payment whose wait reached an answer, the mandate
 * settled or the budget spent, is not waited for again, even when its `paidAt`
 * is ahead of the host clock; the module remembers the last
 * {@link REMEMBERED_PAYMENTS} such payments. A last read cut off at the
 * deadline spends the budget like one that succeeded. A wait that ended on a
 * read that failed before the deadline is not remembered, so the next read of
 * the payment tries again. Only cards
 * wait: a bank mandate can stay pending for days, and an unreadable mandate
 * does not hold the payment back.
 */
export async function AwaitSavedMethod(
  account: Account,
  payment: MolliePayment,
): Promise<void> {
  const card = savedCardOf(payment);
  if (!card) return;
  const { running, finished } = ledgerOf(account);
  if (finished.has(payment.id)) return;
  const shared = running.get(payment.id);
  if (shared) return shared;
  const paidAt = payment.paidAt ? ToEpochMillis(payment.paidAt) : Date.now();
  const deadline = Math.min(Date.now(), paidAt) + MANDATE_WAIT_MS;
  const wait = pollUntilListable(account, card, deadline).then((answered) => {
    running.delete(payment.id);
    if (answered) remember(finished, payment.id);
  });
  running.set(payment.id, wait);
  return wait;
}
