import assert from "node:assert/strict";
import { CreatePayment, type Payment } from "@antelopejs/interface-payment";

import { CurrentHarness } from "./harness";
import {
  Key,
  PrimaryAccount,
  Reference,
  SettledPayment,
  StandIn,
} from "./helpers";

const EUR = (value: number) => ({ value, currency: "EUR" });

export const TEN = EUR(1000);

/** A payment for 25 EUR that Mollie holds, `authorized`, for a later capture. */
export async function AuthorizedHold(): Promise<string> {
  const created = await CreatePayment(
    {
      amount: EUR(2500),
      reference: Reference(),
      paymentMethod: CurrentHarness().chargeable,
      offSession: true,
      authorizeOnly: true,
    },
    Key(),
  );
  assert.equal((await SettledPayment(created.id)).status, "authorized");
  return created.id;
}

export function Captured(payment: Payment): [string, number] {
  return [payment.status, payment.amountCaptured.value];
}

export function PaymentPath(id: string, tail = ""): RegExp {
  return new RegExp(`^/v2/payments/${id}${tail}$`);
}

export function Sent(method: string, path: RegExp): number {
  return PrimaryAccount().requests.filter(
    (request) => request.method === method && path.test(request.path),
  ).length;
}

export function CapturesSent(id: string): number {
  return Sent("POST", PaymentPath(id, "/captures"));
}

export function CapturesHeld(id: string): number {
  return [...PrimaryAccount().captures.values()].filter(
    (capture) => capture.paymentId === id,
  ).length;
}

/** Runs `arm` as the next capture of the payment reaches Mollie, so it acts only on the reads that follow. */
export function OnceCaptured(id: string, arm: () => void): void {
  StandIn().interceptions.push({
    method: "POST",
    path: PaymentPath(id, "/captures"),
    run: arm,
  });
}
