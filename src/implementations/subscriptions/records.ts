import {
  IsMollieCustomer,
  IsMolliePayment,
  IsMolliePaymentPage,
  IsMollieSubscription,
} from "../../mollie/resources";
import { createHash } from "node:crypto";
import {
  CANCELLATION_TIMINGS,
  type CancellationTiming,
  SUBSCRIPTION_INTERVALS,
  type SubscriptionInterval,
  SubscriptionNotFoundError,
} from "@antelopejs/interface-subscriptions";

import type { Account } from "../../accounts";
import { MollieApiError } from "../../mollie/errors";
import { IsJsonValue } from "../../mollie/json";
import { TranslatingSubscription, UnreadablePeriodError } from "./errors";
import { FromMollieInterval, IsBillablePeriod, type Period } from "./calendar";
import { DefinedFields } from "../../mollie/fields";
import { ParseSubscriptionId, SubscriptionId } from "../../mollie/ids";
import {
  type Guard,
  IsCount,
  IsInstant,
  IsText,
  ObjectWith,
  OneOf,
  Optional,
  RecordOf,
} from "../../mollie/guards";
import { MergeOwn, type OwnFields, ReadOwn } from "../../mollie/metadata";
import type {
  JsonValue,
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

/** An early end as the first release stored it: the cancellation key itself, not its hash. */
interface FirstReleaseEarlyEnd {
  endedAt: number;
  endsAt: number;
  key: string;
}

interface OwnCustomer {
  endedEarly: Record<string, JsonValue>;
}

const START_KIND_VALUES: readonly StartKind[] = ["anchor", "charged", "trial"];

const OWN_SUBSCRIPTION: OwnFields<OwnSubscription> = {
  reference: IsText,
  createKey: IsText,
  interval: OneOf(SUBSCRIPTION_INTERVALS),
  intervalCount: IsCount,
  start: OneOf(START_KIND_VALUES),
  firstPayment: IsText,
  refused: IsText,
  cancel: ObjectWith<CancelMark>({
    timing: OneOf(CANCELLATION_TIMINGS),
    key: IsText,
    endsAt: Optional(IsInstant),
  }),
};

const isStoredEarlyEnd: Guard<StoredEarlyEnd> = (
  value,
): value is StoredEarlyEnd =>
  Array.isArray(value) &&
  value.length === 2 &&
  IsCount(value[0]) &&
  IsText(value[1]);

const FIRST_RELEASE_FIELDS = 3;

const isFirstReleaseEarlyEnd: Guard<FirstReleaseEarlyEnd> =
  ObjectWith<FirstReleaseEarlyEnd>({
    endedAt: IsCount,
    endsAt: IsCount,
    key: IsText,
  });

const OWN_CUSTOMER: OwnFields<OwnCustomer> = {
  endedEarly: RecordOf(IsJsonValue),
};

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

const LATEST_PAYMENT_PAGE = { limit: "1" };

function storedPeriod(own: Partial<OwnSubscription>): Period | undefined {
  const { interval, intervalCount: count } = own;
  if (interval === undefined || count === undefined) return undefined;
  const period = { interval, count };
  return IsBillablePeriod(period) ? period : undefined;
}

type OwnFieldsRead = Partial<OwnSubscription> &
  Pick<OwnSubscription, "reference" | "start">;

function ownFields(mollie: MollieSubscription): OwnFieldsRead | undefined {
  const own = ReadOwn(mollie.metadata, OWN_SUBSCRIPTION);
  if (own?.reference === undefined || own.start === undefined) return undefined;
  return { ...own, reference: own.reference, start: own.start };
}

/** The idempotency key `CreateSubscription` stored on a subscription of this module, read without its period. */
export function CreateKeyOf(mollie: MollieSubscription): string | undefined {
  return ownFields(mollie)?.createKey;
}

/**
 * The module's record of a subscription, or undefined when its metadata holds
 * none. Anything holding the API key can change that metadata, so an interval
 * and count the module could not have written read as the interval Mollie
 * bills: `n months` reads as `month` × n. Throws `UnreadablePeriodError`, a
 * `SubscriptionError` naming the subscription, when Mollie's interval is not
 * a form Mollie documents or a period it can bill either.
 */
export function ReadOwnSubscription(
  mollie: MollieSubscription,
): OwnSubscription | undefined {
  const own = ownFields(mollie);
  if (!own) return undefined;
  const period = storedPeriod(own) ?? FromMollieInterval(mollie.interval);
  if (!period) {
    throw new UnreadablePeriodError(
      SubscriptionId(mollie.customerId, mollie.id),
      mollie.interval,
    );
  }
  return { ...own, interval: period.interval, intervalCount: period.count };
}

/**
 * The module's metadata of a subscription the interface shows, or undefined
 * for a refused subscription that Mollie has ended. A refused subscription
 * stays shown while Mollie can still bill it, and after a caller cancelled it.
 */
export function ShownSubscription(
  mollie: MollieSubscription,
): OwnSubscription | undefined {
  const own = ReadOwnSubscription(mollie);
  const isRefusalDone =
    own?.refused !== undefined &&
    own.cancel === undefined &&
    (mollie.status === "canceled" || mollie.status === "completed");
  return isRefusalDone ? undefined : own;
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
  const first = own.firstPayment ?? own.refused;
  return first ? readPayment(account, first) : undefined;
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

function endedEarly(customer: MollieCustomer): Record<string, JsonValue> {
  return ReadOwn(customer.metadata, OWN_CUSTOMER)?.endedEarly ?? {};
}

function toEarlyEnd(stored: JsonValue | undefined): EarlyEnd | undefined {
  if (isStoredEarlyEnd(stored)) {
    const [endedAt, keyHash] = stored;
    return { endedAt, keyHash };
  }
  const isFirstRelease =
    isFirstReleaseEarlyEnd(stored) &&
    Object.keys(stored).length === FIRST_RELEASE_FIELDS;
  if (isFirstRelease) {
    return { endedAt: stored.endedAt, keyHash: KeyHash(stored.key) };
  }
  return undefined;
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

const customerWrites = new Map<string, Promise<void>>();

async function oneAtATime(
  customerId: string,
  write: () => Promise<void>,
): Promise<void> {
  const earlier = customerWrites.get(customerId);
  const current = (async () => {
    await Promise.allSettled([earlier]);
    await write();
  })();
  customerWrites.set(customerId, current);
  try {
    await current;
  } finally {
    if (customerWrites.get(customerId) === current) {
      customerWrites.delete(customerId);
    }
  }
}

/**
 * Adds the subscription's early end to its customer's metadata. The write
 * carries every early end the read before it found, and Mollie has no
 * conditional update, so two early ends written from one earlier read would
 * erase each other. Within this process, each customer's early ends are read
 * and written one at a time.
 */
export async function RecordEarlyEnd(
  account: Account,
  record: SubscriptionRecord,
  earlyEnd: EarlyEnd,
): Promise<void> {
  const { customerId } = record.mollie;
  await oneAtATime(customerId, async () => {
    const customer = await readCustomer(account, customerId);
    const merged = {
      ...endedEarly(customer),
      [record.mollie.id]: [earlyEnd.endedAt, earlyEnd.keyHash],
    };
    await account.client.execute({
      method: "PATCH",
      path: `/customers/${customer.id}`,
      body: { metadata: MergeOwn(customer.metadata, { endedEarly: merged }) },
    });
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

/** Loads the record of subscription `id`, reading it from Mollie unless `fetched` already holds it. */
export async function LoadRecord(
  account: Account,
  id: string,
  fetched?: MollieSubscription,
): Promise<SubscriptionRecord> {
  const parsed = ParseSubscriptionId(id);
  if (!parsed) throw new SubscriptionNotFoundError(id);
  const mollie =
    fetched ?? (await FetchSubscription(account, parsed.parent, parsed.child));
  const own = ShownSubscription(mollie);
  if (!own) throw new SubscriptionNotFoundError(id);
  return TranslatingSubscription(id, () =>
    CompleteRecord(account, id, mollie, own),
  );
}
