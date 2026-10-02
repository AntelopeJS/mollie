import type { Account } from "../../accounts";
import { ReadOwn } from "../../mollie/metadata";
import { IsNotFound } from "../../mollie/errors";
import { SubscriptionId } from "../../mollie/ids";
import type { MolliePayment, MollieSubscription } from "../../mollie/types";

interface OwnSubscriptionData {
  reference: string;
}

interface OwnChargeData {
  subscription: string;
}

function IsOwnSubscription(subscription: MollieSubscription): boolean {
  return (
    typeof ReadOwn<OwnSubscriptionData>(subscription.metadata)?.reference ===
    "string"
  );
}

async function spawnedBy(
  account: Account,
  customerId: string,
  subscriptionId: string,
): Promise<MollieSubscription | undefined> {
  try {
    return await account.client.request<MollieSubscription>({
      method: "GET",
      path: `/customers/${customerId}/subscriptions/${subscriptionId}`,
    });
  } catch (error) {
    if (IsNotFound(error)) return undefined;
    throw error;
  }
}

export async function SubscriptionOfPayment(
  account: Account,
  payment: MolliePayment,
): Promise<string | undefined> {
  const charged = ReadOwn<OwnChargeData>(payment.metadata)?.subscription;
  if (typeof charged === "string") return charged;
  if (!payment.subscriptionId || !payment.customerId) return undefined;
  const subscription = await spawnedBy(
    account,
    payment.customerId,
    payment.subscriptionId,
  );
  return subscription && IsOwnSubscription(subscription)
    ? SubscriptionId(payment.customerId, payment.subscriptionId)
    : undefined;
}
