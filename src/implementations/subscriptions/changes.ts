import { IsMollieSubscription } from "../../mollie/resources";
import {
  CANCELLATION_TIMINGS,
  type CancellationTiming,
  InvalidSubscriptionRequestError,
  InvalidSubscriptionStateError,
  type Subscription,
} from "@antelopejs/interface-subscriptions";

import { ToSubscription } from "./mapping";
import type { Account } from "../../accounts";
import { ChargeableMandate } from "./creation";
import { MollieApiError } from "../../mollie/errors";
import { MergeOwn } from "../../mollie/metadata";
import { LifecycleEvent, Raise } from "./events";
import { DefinedFields } from "../../mollie/fields";
import type { MollieSubscription } from "../../mollie/types";
import { IsMollieId, SubscriptionId } from "../../mollie/ids";
import { SubscriptionAccount, TranslatingSubscription } from "./errors";
import {
  type CancelMark,
  CompleteRecord,
  LoadRecord,
  KeyHash,
  RecordEarlyEnd,
  ShownSubscription,
  SubscriptionPath,
  type SubscriptionRecord,
} from "./records";

const SUBSCRIPTION_PAGE = "?limit=250";

export async function GetSubscription(
  id: string,
  provider?: string,
): Promise<Subscription> {
  return ToSubscription(await LoadRecord(SubscriptionAccount(provider), id));
}

async function listed(
  account: Account,
  customer: string,
): Promise<MollieSubscription[]> {
  try {
    return await account.client.list(
      `/customers/${customer}/subscriptions${SUBSCRIPTION_PAGE}`,
      "subscriptions",
      IsMollieSubscription,
    );
  } catch (error) {
    if (error instanceof MollieApiError && error.isNotFound) return [];
    throw error;
  }
}

export async function ListSubscriptions(
  customer: string,
  provider?: string,
): Promise<Subscription[]> {
  if (!IsMollieId("customer", customer)) return [];
  const account = SubscriptionAccount(provider);
  return TranslatingSubscription(customer, async () => {
    const records = await Promise.all(
      (await listed(account, customer)).flatMap((mollie) => {
        const own = ShownSubscription(mollie);
        if (!own) return [];
        const id = SubscriptionId(customer, mollie.id);
        return [CompleteRecord(account, id, mollie, own)];
      }),
    );
    return records
      .map((record) => ToSubscription(record))
      .sort((first, second) => second.createdAt - first.createdAt);
  });
}

function isSameRequest(record: SubscriptionRecord, key: string): boolean {
  return (
    record.own.cancel?.key === key || record.earlyEnd?.keyHash === KeyHash(key)
  );
}

async function replayOrRefuse(
  record: SubscriptionRecord,
  current: Subscription,
  key: string,
): Promise<Subscription> {
  if (!isSameRequest(record, key)) {
    throw new InvalidSubscriptionStateError(
      `Subscription ${record.id} has ended`,
      "canceled",
    );
  }
  await Raise(LifecycleEvent("subscription.canceled", current));
  return current;
}

async function cancelAtMollie(
  account: Account,
  record: SubscriptionRecord,
  mark: CancelMark,
): Promise<Subscription> {
  const { mollie } = record;
  const path = SubscriptionPath(mollie.customerId, mollie.id);
  await account.client.execute({
    method: "PATCH",
    path,
    body: { metadata: MergeOwn(mollie.metadata, { cancel: mark }) },
  });
  await account.client.execute({ method: "DELETE", path });
  return ToSubscription(await LoadRecord(account, record.id));
}

async function endEarly(
  account: Account,
  record: SubscriptionRecord,
  key: string,
): Promise<Subscription> {
  await RecordEarlyEnd(account, record, {
    endedAt: Date.now(),
    keyHash: KeyHash(key),
  });
  return ToSubscription(await LoadRecord(account, record.id));
}

async function cancel(
  account: Account,
  record: SubscriptionRecord,
  key: string,
  timing: CancellationTiming,
): Promise<Subscription> {
  const current = ToSubscription(record);
  if (current.status === "canceled") {
    return replayOrRefuse(record, current, key);
  }
  if (current.cancelAtPeriodEnd && timing === "period_end") return current;
  const updated = current.cancelAtPeriodEnd
    ? await endEarly(account, record, key)
    : await cancelAtMollie(account, record, {
        timing,
        key,
        ...DefinedFields({
          endsAt:
            timing === "period_end" ? current.currentPeriodEnd : undefined,
        }),
      });
  if (updated.status === "canceled") {
    await Raise(LifecycleEvent("subscription.canceled", updated));
  }
  return updated;
}

export async function CancelSubscription(
  id: string,
  idempotencyKey: string,
  timing: CancellationTiming,
  provider?: string,
): Promise<Subscription> {
  if (!CANCELLATION_TIMINGS.includes(timing)) {
    throw new InvalidSubscriptionRequestError(
      `Unknown cancellation timing: ${timing}`,
    );
  }
  const account = SubscriptionAccount(provider);
  const record = await LoadRecord(account, id);
  return TranslatingSubscription(id, () =>
    cancel(account, record, idempotencyKey, timing),
  );
}

function assertChangeable(current: Subscription): void {
  if (current.status === "canceled") {
    throw new InvalidSubscriptionStateError(
      `Subscription ${current.id} has ended`,
      "canceled",
    );
  }
  if (current.cancelAtPeriodEnd) {
    throw new InvalidSubscriptionStateError(
      `Subscription ${current.id} is set to end at ${new Date(current.currentPeriodEnd).toISOString()} and will not be charged again; Mollie cannot change it any more`,
      current.status,
    );
  }
}

export async function UpdateSubscriptionPaymentMethod(
  id: string,
  paymentMethod: string,
  _idempotencyKey: string,
  provider?: string,
): Promise<Subscription> {
  const account = SubscriptionAccount(provider);
  const record = await LoadRecord(account, id);
  assertChangeable(ToSubscription(record));
  const { mollie } = record;
  const mandateId = await ChargeableMandate(
    account,
    mollie.customerId,
    paymentMethod,
  );
  return TranslatingSubscription(id, async () => {
    await account.client.execute({
      method: "PATCH",
      path: SubscriptionPath(mollie.customerId, mollie.id),
      body: { mandateId },
    });
    return ToSubscription(await LoadRecord(account, id));
  });
}
