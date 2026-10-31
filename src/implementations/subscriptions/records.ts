import {
  IsMollieCustomer,
  IsMolliePayment,
  IsMolliePaymentPage,
  IsMollieSubscription,
} from "../../mollie/resources";
import { createHash } from "node:crypto";
import {
  type CancellationTiming,
  type SubscriptionInterval,
  SubscriptionNotFoundError,
} from "@antelopejs/interface-subscriptions";

import type { Account } from "../../accounts";
import { MollieApiError } from "../../mollie/errors";
import { TranslatingSubscription } from "./errors";
import { IsSubscriptionInterval } from "./calendar";
import { DefinedFields } from "../../mollie/fields";
import { ParseSubscriptionId } from "../../mollie/ids";
import {
  IsJsonNumber,
  IsJsonString,
  MergeOwn,
  ReadOwn,
} from "../../mollie/metadata";
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
  createKey?: string;
  interval: SubscriptionInterval;
  intervalCount: number;
  start: StartKind;
  firstPayment?: string;
  refused?: string;
  cancel?: CancelMark;
}

export interface EarlyEnd {
  endedAt: number;
  keyHash: string;
}

type StoredEarlyEnd = [number, string];

interface OwnCustomer {
  endedEarly: Record<string, StoredEarlyEnd>;
}

const KEY_HASH_LENGTH = 8;

export function KeyHash(idempotencyKey: string): string {
  return createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, KEY_HASH_LENGTH);
}

export interface SubscriptionRecord {
  id: string;
  mollie: MollieSubscription;
  own: OwnSubscription;
  latest?: MolliePayment;
  earlyEnd?: EarlyEnd;
}

const START_KINDS = new Set<string>(["anchor", "charged", "trial"]);
const LATEST_PAYMENT_PAGE = { limit: "1" };

export function ReadOwnSubscription(
  mollie: MollieSubscription,
): OwnSubscription | undefined {
  const own = ReadOwn<OwnSubscription>(mollie.metadata);
  if (
    !IsJsonString(own?.reference) ||
    !IsSubscriptionInterval(own.interval) ||
    !IsJsonNumber(own.intervalCount) ||
    own.start === undefined ||
    !START_KINDS.has(own.start)
  )
    return undefined;
  return {
    ...own,
    reference: own.reference,
    interval: own.interval,
    intervalCount: own.intervalCount,
    start: own.start,
  };
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
    account.client.request(
      {
        method: "GET",
        path: SubscriptionPath(customerId, subscriptionId),
      },
      IsMollieSubscription,
    ),
  );
}

async function readPayment(
  account: Account,
  id: string,
): Promise<MolliePayment> {
  return account.client.request(
    {
      method: "GET",
      path: `/payments/${id}`,
    },
    IsMolliePayment,
  );
}

async function latestPayment(
  account: Account,
  mollie: MollieSubscription,
  own: OwnSubscription,
): Promise<MolliePayment | undefined> {
  const spawned = await account.client.request(
    {
      method: "GET",
      path: `${SubscriptionPath(mollie.customerId, mollie.id)}/payments`,
      query: LATEST_PAYMENT_PAGE,
    },
    IsMolliePaymentPage,
  );
  const newest = spawned._embedded?.payments?.[0];
  if (newest) return newest;
  return own.firstPayment ? readPayment(account, own.firstPayment) : undefined;
}

async function readCustomer(
  account: Account,
  customerId: string,
): Promise<MollieCustomer> {
  return account.client.request(
    {
      method: "GET",
      path: `/customers/${customerId}`,
    },
    IsMollieCustomer,
  );
}

function endedEarly(customer: MollieCustomer): Record<string, StoredEarlyEnd> {
  return ReadOwn<OwnCustomer>(customer.metadata)?.endedEarly ?? {};
}

function toEarlyEnd(stored: StoredEarlyEnd | undefined): EarlyEnd | undefined {
  if (!Array.isArray(stored)) return undefined;
  const [endedAt, keyHash] = stored;
  return { endedAt, keyHash };
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
    return toEarlyEnd(
      endedEarly(await readCustomer(account, mollie.customerId))[mollie.id],
    );
  } catch (error) {
    if (error instanceof MollieApiError && error.isNotFound) return undefined;
    throw error;
  }
}

export async function RecordEarlyEnd(
  account: Account,
  record: SubscriptionRecord,
  earlyEnd: EarlyEnd,
): Promise<void> {
  const customer = await readCustomer(account, record.mollie.customerId);
  const merged = {
    ...endedEarly(customer),
    [record.mollie.id]: [earlyEnd.endedAt, earlyEnd.keyHash],
  };
  await account.client.execute({
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
