import {
  type Subscription,
  type SubscriptionEvent,
  type SubscriptionEventHandler,
  type SubscriptionEventType,
  SubscriptionNotFoundError,
} from "@antelopejs/interface-subscriptions";

import { LoadRecord } from "./records";
import { ToSubscription } from "./mapping";
import type { Account } from "../../accounts";
import type { ChargedSubscription } from "../shared/subscription-of-payment";
import type { MolliePayment, MolliePaymentStatus } from "../../mollie/types";

const handlers = new Map<string, SubscriptionEventHandler>();

const CHARGE_EVENT_BY_STATUS: Partial<
  Record<MolliePaymentStatus, SubscriptionEventType>
> = {
  canceled: "subscription.payment_failed",
  expired: "subscription.payment_failed",
  failed: "subscription.payment_failed",
  paid: "subscription.payment_succeeded",
};

export function RegisterHandler(
  id: string,
  handler: SubscriptionEventHandler,
): void {
  handlers.set(id, handler);
}

export function UnregisterHandler(id: string): void {
  handlers.delete(id);
}

export async function Raise(event: SubscriptionEvent): Promise<void> {
  await Promise.all(
    [...handlers.values()].map(async (handler) => handler(event)),
  );
}

export function LifecycleEvent(
  type: SubscriptionEventType,
  subscription: Subscription,
): SubscriptionEvent {
  return {
    id: `${subscription.id}:${type}`,
    type,
    createdAt:
      type === "subscription.canceled"
        ? (subscription.endedAt ?? Date.now())
        : subscription.createdAt,
    subscription,
  };
}

async function currentState(
  account: Account,
  charged: ChargedSubscription,
): Promise<Subscription | undefined> {
  try {
    return ToSubscription(
      await LoadRecord(account, charged.id, charged.mollie),
    );
  } catch (error) {
    if (error instanceof SubscriptionNotFoundError) return undefined;
    throw error;
  }
}

function chargeTime(payment: MolliePayment): number {
  const at = payment.paidAt ?? payment.failedAt ?? payment.expiredAt;
  return Date.parse(at ?? payment.canceledAt ?? payment.createdAt);
}

export async function DispatchChargeEvents(
  account: Account,
  payment: MolliePayment,
  charged: ChargedSubscription | undefined,
): Promise<void> {
  const type = CHARGE_EVENT_BY_STATUS[payment.status];
  if (!type || !charged) return;
  const subscription = await currentState(account, charged);
  if (!subscription) return;
  await Raise({
    id: `${charged.id}:${payment.id}:${payment.status}`,
    type,
    createdAt: chargeTime(payment),
    subscription,
    payment: payment.id,
  });
  const isGivenUp =
    subscription.status === "canceled" &&
    subscription.endReason === "payment_failed";
  if (isGivenUp) {
    await Raise(LifecycleEvent("subscription.canceled", subscription));
  }
}
