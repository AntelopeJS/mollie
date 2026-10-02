import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GetPayment, type Payment } from "@antelopejs/interface-payment";

import { CurrentHarness } from "./harness";
import type { Account } from "../stand-in/state";
import type { MollieStandIn } from "../stand-in/server";

const SETTLE_TIMEOUT_MS = 20_000;
const SETTLE_POLL_MS = 50;
const RETURN_URL = "https://merchant.invalid/return/module-tests";

export const TEST_TIMEOUT = 60_000;
export const FORM = { "content-type": "application/x-www-form-urlencoded" };

export function Key(): string {
  return `mollie-module-test-${randomUUID()}`;
}

export function Reference(): string {
  return `module-test-${randomUUID()}`;
}

export function ReturnUrl(): string {
  return RETURN_URL;
}

export function StandIn(): MollieStandIn {
  const standIn = CurrentHarness().standIn;
  if (!standIn) throw new Error("This test needs the stand-in");
  return standIn;
}

export function PrimaryAccount(): Account {
  return StandIn().account(CurrentHarness().target.apiKey);
}

export function RequireStandIn(context: Mocha.Context): void {
  if (!CurrentHarness().standIn) context.skip();
}

export async function SettledPayment(
  id: string,
  isSettled: (payment: Payment) => boolean = (payment) =>
    payment.status !== "pending" && payment.status !== "requires_action",
  provider?: string,
): Promise<Payment> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let payment = await GetPayment(id, provider);
  while (!isSettled(payment) && Date.now() < deadline) {
    await delay(SETTLE_POLL_MS);
    payment = await GetPayment(id, provider);
  }
  return payment;
}

export async function Within<T>(
  offsetMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try {
    return await work();
  } finally {
    Date.now = realNow;
  }
}

export async function Eventually(
  check: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (!check() && Date.now() < deadline) {
    await delay(SETTLE_POLL_MS);
  }
  if (!check()) throw new Error(`Timed out waiting for ${label}`);
}

export function WebhookBody(
  id: string,
  extra: Record<string, string> = {},
): Buffer {
  return Buffer.from(new URLSearchParams({ id, ...extra }).toString());
}
