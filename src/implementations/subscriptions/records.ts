import {
  type CancellationTiming,
  SUBSCRIPTION_INTERVALS,
  type SubscriptionInterval,
  SubscriptionNotFoundError,
} from "@antelopejs/interface-subscriptions";

import type { Account } from "../../accounts";
import { IsNotFound } from "../../mollie/errors";
import { TranslatingSubscription } from "./errors";
import { DefinedFields } from "../../mollie/fields";
import { ParseSubscriptionId } from "../../mollie/ids";
import { MergeOwn, ReadOwn } from "../../mollie/metadata";
import type {
  MollieCustomer,
  MolliePayment,
  MollieSubscription,
} from "../../mollie/types";

export type StartKind = "anchor" | "charged" | "trial";

export interface CancelMark {
  timing: CancellationTiming;
  key: string;
  endsAt?: number;
}

export interface OwnSubscription {
  reference: string;
  createKey: string;
  interval: SubscriptionInterval;
  intervalCount: number;
  start: StartKind;
  firstPayment?: string;
  refused?: string;
  cancel?: CancelMark;
}

export interface EarlyEnd {
  endedAt: number;
  endsAt: number;
  key: string;
}

interface OwnCustomer {
  endedEarly: Record<string, EarlyEnd>;
}

export interface SubscriptionRecord {
  id: string;
  mollie: MollieSubscription;
  own: OwnSubscription;
  latest?: MolliePayment;
  earlyEnd?: EarlyEnd;
}

interface PaymentList {
  payments?: MolliePayment[];
}

interface PaymentPage {
  _embedded?: PaymentList;
}

const START_KINDS = new Set<string>(["anchor", "charged", "trial"]);
const LATEST_PAYMENT_PAGE = { limit: "1" };

export function ReadOwnSubscription(
  mollie: MollieSubscription,
): OwnSubscription | undefined {
  const own = ReadOwn<OwnSubscription>(mollie.metadata);
  const isOwn =
    typeof own?.reference === "string" &&
    SUBSCRIPTION_INTERVALS.includes(own.interval as SubscriptionInterval) &&
    typeof own.intervalCount === "number" &&
    START_KINDS.has(own.start ?? "");
  return isOwn ? (own as OwnSubscription) : undefined;
}

export function SubscriptionPath(customerId: string, id: string): string {
  return `/customers/${customerId}/subscriptions/${id}`;
}

async function FetchSubscription(
  account: Account,
  customerId: string,
  subscriptionId: string,
): Promise<MollieSubscription> {
  return TranslatingSubscription(`${customerId}:${subscriptionId}`, () =>
    account.client.request<MollieSubscription>({
      method: "GET",
      path: SubscriptionPath(customerId, subscriptionId),
    }),
  );
}

async function readPayment(
  account: Account,
  id: string,
): Promise<MolliePayment> {
  return account.client.request<MolliePayment>({
    method: "GET",
    path: `/payments/${id}`,
  });
}

async function latestPayment(
  account: Account,
  mollie: MollieSubscription,
  own: OwnSubscription,
): Promise<MolliePayment | undefined> {
  const spawned = await account.client.request<PaymentPage>({
    method: "GET",
    path: `${SubscriptionPath(mollie.customerId, mollie.id)}/payments`,
    query: LATEST_PAYMENT_PAGE,
  });
  const newest = spawned._embedded?.payments?.[0];
  if (newest) return newest;
  return own.firstPayment ? readPayment(account, own.firstPayment) : undefined;
}

async function readCustomer(
  account: Account,
  customerId: string,
): Promise<MollieCustomer> {
  return account.client.request<MollieCustomer>({
    method: "GET",
    path: `/customers/${customerId}`,
  });
}

function endedEarly(customer: MollieCustomer): Record<string, EarlyEnd> {
  return ReadOwn<OwnCustomer>(customer.metadata)?.endedEarly ?? {};
}

async function earlyEndOf(
  account: Account,
  mollie: MollieSubscription,
  own: OwnSubscription,
): Promise<EarlyEnd | undefined> {
  const isEndingLater =
    mollie.status === "canceled" && own.cancel?.timing === "period_end";
  if (!isEndingLater) return undefined;
  try {
    return endedEarly(await readCustomer(account, mollie.customerId))[
      mollie.id
    ];
  } catch (error) {
    if (IsNotFound(error)) return undefined;
    throw error;
  }
}

export async function RecordEarlyEnd(
  account: Account,
  record: SubscriptionRecord,
  earlyEnd: EarlyEnd,
): Promise<void> {
  const customer = await readCustomer(account, record.mollie.customerId);
  const now = Date.now();
  const current = Object.entries(endedEarly(customer)).filter(
    ([, entry]) => entry.endsAt > now,
  );
  const merged = Object.fromEntries([...current, [record.mollie.id, earlyEnd]]);
  await account.client.request({
    method: "PATCH",
    path: `/customers/${customer.id}`,
    body: { metadata: MergeOwn(customer.metadata, { endedEarly: merged }) },
  });
}

export async function CompleteRecord(
  account: Account,
  id: string,
  mollie: MollieSubscription,
  own: OwnSubscription,
): Promise<SubscriptionRecord> {
  const [latest, earlyEnd] = await Promise.all([
    latestPayment(account, mollie, own),
    earlyEndOf(account, mollie, own),
  ]);
  return {
    id,
    mollie,
    own,
    ...DefinedFields({ latest, earlyEnd }),
  };
}

export async function LoadRecord(
  account: Account,
  id: string,
): Promise<SubscriptionRecord> {
  const parsed = ParseSubscriptionId(id);
  if (!parsed) throw new SubscriptionNotFoundError(id);
  const mollie = await FetchSubscription(account, parsed.parent, parsed.child);
  const own = ReadOwnSubscription(mollie);
  if (!own || own.refused) throw new SubscriptionNotFoundError(id);
  return TranslatingSubscription(id, () =>
    CompleteRecord(account, id, mollie, own),
  );
}
