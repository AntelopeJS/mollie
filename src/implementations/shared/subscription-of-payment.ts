import { IsMollieSubscription } from "../../mollie/resources";
import type { Account } from "../../accounts";
import { IsText } from "../../mollie/guards";
import { type OwnFields, ReadOwn } from "../../mollie/metadata";
import { MollieApiError } from "../../mollie/errors";
import { SubscriptionId } from "../../mollie/ids";
import type { MolliePayment, MollieSubscription } from "../../mollie/types";

interface OwnSubscriptionData {
  reference: string;
}

interface OwnChargeData {
  subscription: string;
}

const OWN_SUBSCRIPTION: OwnFields<OwnSubscriptionData> = { reference: IsText };
const OWN_CHARGE: OwnFields<OwnChargeData> = { subscription: IsText };

function isOwnSubscriptionData(
  own: Partial<OwnSubscriptionData> | undefined,
): own is OwnSubscriptionData {
  return typeof own?.reference === "string";
}

function isOwnChargeData(
  own: Partial<OwnChargeData> | undefined,
): own is OwnChargeData {
  return typeof own?.subscription === "string";
}

function IsOwnSubscription(subscription: MollieSubscription): boolean {
  return isOwnSubscriptionData(
    ReadOwn(subscription.metadata, OWN_SUBSCRIPTION),
  );
}

async function spawnedBy(
  account: Account,
  customerId: string,
  subscriptionId: string,
): Promise<MollieSubscription | undefined> {
  try {
    return await account.client.request(
      {
        method: "GET",
        path: `/customers/${customerId}/subscriptions/${subscriptionId}`,
      },
      IsMollieSubscription,
    );
  } catch (error) {
    if (error instanceof MollieApiError && error.isNotFound) return undefined;
    throw error;
  }
}

export async function SubscriptionOfPayment(
  account: Account,
  payment: MolliePayment,
): Promise<string | undefined> {
  const charged = ReadOwn(payment.metadata, OWN_CHARGE);
  if (isOwnChargeData(charged)) return charged.subscription;
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
