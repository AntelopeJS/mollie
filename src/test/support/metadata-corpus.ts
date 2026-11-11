import {
  CapturePayment,
  GetCustomer,
  GetPayment,
  GetRefund,
  InvalidPaymentStateError,
  RefundPayment,
} from "@antelopejs/interface-payment";
import {
  GetSubscription,
  SubscriptionNotFoundError,
} from "@antelopejs/interface-subscriptions";

import {
  type Guard,
  IsCount,
  IsFlag,
  IsText,
  ListOf,
  Nullable,
  ObjectWith,
  OneOf,
  Optional,
  RecordOf,
} from "../../mollie/guards";
import { RefundId, SubscriptionId } from "../../mollie/ids";
import { IsJsonValue } from "../../mollie/json";
import type {
  JsonValue,
  MolliePayment,
  MolliePaymentStatus,
} from "../../mollie/types";
import type { Account } from "../stand-in/state";
import { IsNumberValue, IsObject, IsTextValue } from "./metadata-model";

type Caller = Record<string, string> | null;

interface SeedRecord {
  id: string;
  metadata: JsonValue;
}

interface SeedPayment extends SeedRecord {
  status?: MolliePaymentStatus;
  customerId?: string;
  subscriptionId?: string;
}

interface SeedSubscription extends SeedRecord {
  status: "active" | "canceled";
}

interface SeedChild extends SeedRecord {
  paymentId: string;
}

interface Seed {
  customer?: SeedRecord;
  subscription?: SeedSubscription;
  payments?: SeedPayment[];
  refund?: SeedChild;
  capture?: SeedChild;
}

interface PaymentRead {
  id: string;
  reference: string;
  metadata: Caller;
}

interface RefundRead {
  metadata: Caller;
  replayKey: string | null;
}

interface CaptureRead {
  replayKey: string | null;
}

interface CustomerRead {
  metadata: Caller;
}

interface SubscriptionRead {
  reference: string;
  interval: string;
  intervalCount: number;
  status: string;
  cancelAtPeriodEnd: boolean;
  endedAt: number | null;
  trialEnd: number | null;
  latestPayment: string | null;
  metadata: Caller;
}

/** What a fixture's records read as through the interfaces; a `null` subscription is one the interface does not find. */
export interface Reads {
  payment?: PaymentRead;
  refund?: RefundRead;
  capture?: CaptureRead;
  customer?: CustomerRead;
  subscription?: SubscriptionRead | null;
}

/** One stored shape: the records holding it, and what the version that wrote it read back. */
export interface Fixture {
  name: string;
  since: string;
  until: string | null;
  writer: string;
  finding?: string;
  seed: Seed;
  reads: Reads;
}

function OrNull<T>(guard: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || guard(value);
}

const IsCaller: Guard<Caller> = OrNull(RecordOf(IsText));
const IsSeedRecord = ObjectWith<SeedRecord>({
  id: IsText,
  metadata: IsJsonValue,
});
const IsSeedChild = ObjectWith<SeedChild>({
  id: IsText,
  metadata: IsJsonValue,
  paymentId: IsText,
});

const IsFixture = ObjectWith<Fixture>({
  name: IsText,
  since: IsText,
  until: OrNull(IsText),
  writer: IsText,
  finding: Optional(IsText),
  seed: ObjectWith<Seed>({
    customer: Optional(IsSeedRecord),
    subscription: Optional(
      ObjectWith<SeedSubscription>({
        id: IsText,
        metadata: IsJsonValue,
        status: OneOf(["active", "canceled"]),
      }),
    ),
    payments: Optional(
      ListOf(
        ObjectWith<SeedPayment>({
          id: IsText,
          metadata: IsJsonValue,
          status: Optional(OneOf(["open", "paid", "failed"])),
          customerId: Optional(IsText),
          subscriptionId: Optional(IsText),
        }),
      ),
    ),
    refund: Optional(IsSeedChild),
    capture: Optional(IsSeedChild),
  }),
  reads: ObjectWith<Reads>({
    payment: Optional(
      ObjectWith<PaymentRead>({
        id: IsText,
        reference: IsText,
        metadata: IsCaller,
      }),
    ),
    refund: Optional(
      ObjectWith<RefundRead>({
        metadata: IsCaller,
        replayKey: OrNull(IsText),
      }),
    ),
    capture: Optional(ObjectWith<CaptureRead>({ replayKey: OrNull(IsText) })),
    customer: Optional(ObjectWith<CustomerRead>({ metadata: IsCaller })),
    subscription: Nullable(
      ObjectWith<SubscriptionRead>({
        reference: IsText,
        interval: IsText,
        intervalCount: IsCount,
        status: IsText,
        cancelAtPeriodEnd: IsFlag,
        endedAt: OrNull(IsCount),
        trialEnd: OrNull(IsCount),
        latestPayment: OrNull(IsText),
        metadata: IsCaller,
      }),
    ),
  }),
});

interface Corpus {
  source: string;
  fixtures: Fixture[];
}

/** Whether a corpus file holds well-formed fixtures. */
export const IsCorpus = ObjectWith<Corpus>({
  source: IsText,
  fixtures: ListOf(IsFixture),
});

const AMOUNT = { currency: "EUR", value: "10.00" };
const CREATED_AT = "2026-01-14T10:00:00+00:00";
const CANCELED_AT = "2026-06-01T10:00:00+00:00";
const UNKNOWN_KEY = "corpus-unknown-key";

function stored(metadata: JsonValue): JsonValue {
  return structuredClone(metadata);
}

function seedPayment(account: Account, seed: SeedPayment): void {
  const payment: MolliePayment = {
    resource: "payment",
    id: seed.id,
    mode: "test",
    description: `corpus ${seed.id}`,
    amount: AMOUNT,
    status: seed.status ?? "paid",
    sequenceType: seed.subscriptionId ? "recurring" : "oneoff",
    metadata: stored(seed.metadata),
    customerId: seed.customerId ?? null,
    subscriptionId: seed.subscriptionId ?? null,
    createdAt: CREATED_AT,
    _links: {},
  };
  account.payments.set(seed.id, payment);
}

/** Stores a fixture's records in the stand-in account, as Mollie would hold them. */
export function SeedFixture(account: Account, fixture: Fixture): void {
  const { customer, subscription, payments, refund, capture } = fixture.seed;
  if (customer) {
    account.customers.set(customer.id, {
      resource: "customer",
      id: customer.id,
      name: null,
      email: null,
      metadata: stored(customer.metadata),
      createdAt: CREATED_AT,
    });
  }
  if (subscription && customer) {
    const isActive = subscription.status === "active";
    account.subscriptions.set(subscription.id, {
      resource: "subscription",
      id: subscription.id,
      status: subscription.status,
      amount: AMOUNT,
      interval: "1 month",
      startDate: "2026-01-15",
      nextPaymentDate: isActive ? "2026-12-15" : null,
      description: `corpus ${subscription.id}`,
      metadata: stored(subscription.metadata),
      customerId: customer.id,
      createdAt: CREATED_AT,
      canceledAt: isActive ? null : CANCELED_AT,
    });
  }
  for (const payment of payments ?? []) seedPayment(account, payment);
  if (refund) {
    account.refunds.set(refund.id, {
      resource: "refund",
      id: refund.id,
      amount: AMOUNT,
      status: "refunded",
      paymentId: refund.paymentId,
      description: "corpus refund",
      metadata: stored(refund.metadata),
      createdAt: CREATED_AT,
    });
  }
  if (capture) {
    account.captures.set(capture.id, {
      resource: "capture",
      id: capture.id,
      mode: "test",
      amount: AMOUNT,
      status: "succeeded",
      paymentId: capture.paymentId,
      metadata: stored(capture.metadata),
      createdAt: CREATED_AT,
    });
  }
}

async function replayed(
  expected: string | null,
  replay: (key: string) => Promise<boolean>,
): Promise<string | null> {
  const key = expected ?? UNKNOWN_KEY;
  try {
    return (await replay(key)) ? key : `${key} replayed another record`;
  } catch (error) {
    if (error instanceof InvalidPaymentStateError) return null;
    throw error;
  }
}

async function readSubscription(
  customer: string,
  subscription: string,
): Promise<SubscriptionRead | null> {
  try {
    const read = await GetSubscription(SubscriptionId(customer, subscription));
    return {
      reference: read.reference,
      interval: read.interval,
      intervalCount: read.intervalCount,
      status: read.status,
      cancelAtPeriodEnd: read.cancelAtPeriodEnd,
      endedAt: read.endedAt ?? null,
      trialEnd: read.trialEnd ?? null,
      latestPayment: read.latestPayment ?? null,
      metadata: read.metadata ?? null,
    };
  } catch (error) {
    if (error instanceof SubscriptionNotFoundError) return null;
    throw error;
  }
}

/**
 * Reads a seeded fixture through the interfaces, for each read the fixture
 * records. A replay read runs the call under the recorded key, or under an
 * unknown key when none is recorded, on a payment whose state refuses a new
 * refund or capture: only a replay resolves.
 */
export async function ReadFixture(fixture: Fixture): Promise<Reads> {
  const { seed, reads: expected } = fixture;
  const reads: Reads = {};
  if (expected.payment) {
    const payment = await GetPayment(expected.payment.id);
    reads.payment = {
      id: payment.id,
      reference: payment.reference,
      metadata: payment.metadata ?? null,
    };
  }
  const { refund, capture, customer, subscription } = seed;
  if (expected.refund && refund) {
    const id = RefundId(refund.paymentId, refund.id);
    reads.refund = {
      metadata: (await GetRefund(id)).metadata ?? null,
      replayKey: await replayed(
        expected.refund.replayKey,
        async (key) =>
          (await RefundPayment({ payment: refund.paymentId }, key)).id === id,
      ),
    };
  }
  if (expected.capture && capture) {
    reads.capture = {
      replayKey: await replayed(
        expected.capture.replayKey,
        async (key) =>
          (await CapturePayment(capture.paymentId, key)).id ===
          capture.paymentId,
      ),
    };
  }
  if (expected.customer && customer) {
    reads.customer = {
      metadata: (await GetCustomer(customer.id)).metadata ?? null,
    };
  }
  if (expected.subscription !== undefined && customer && subscription) {
    reads.subscription = await readSubscription(customer.id, subscription.id);
  }
  return reads;
}

const MOLLIE_ID = /^(?:cst|sub|tr|re|cpt)_[A-Za-z0-9]+$/;

function formatOf(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(formatOf).join(",")}]`;
  if (IsObject(value)) {
    const fields = Object.entries(value).map(
      ([key, field]) =>
        `${MOLLIE_ID.test(key) ? "<id>" : key}:${formatOf(field)}`,
    );
    return `{${[...new Set(fields)].sort().join(",")}}`;
  }
  if (value === null) return "null";
  if (IsTextValue(value)) return "string";
  return IsNumberValue(value) ? "number" : "boolean";
}

/**
 * The stored format of metadata: its keys and value types, with Mollie ids as
 * keys collapsed and the caller's string map under the caller key read as
 * one string.
 */
export function FormatOf(metadata: JsonValue): string {
  if (!IsObject(metadata)) return formatOf(metadata);
  const caller = metadata.metadata;
  const isCaller = IsObject(caller) && Object.values(caller).every(IsTextValue);
  return formatOf(isCaller ? { ...metadata, metadata: "<caller>" } : metadata);
}

/** The resource each seeded record is, with its stored metadata. */
export function SeededRecords(
  fixture: Fixture,
): { resource: string; metadata: JsonValue }[] {
  const { customer, subscription, payments, refund, capture } = fixture.seed;
  return [
    ...(customer
      ? [{ resource: "customer", metadata: customer.metadata }]
      : []),
    ...(subscription
      ? [{ resource: "subscription", metadata: subscription.metadata }]
      : []),
    ...(payments ?? []).map(({ metadata }) => ({
      resource: "payment",
      metadata,
    })),
    ...(refund ? [{ resource: "refund", metadata: refund.metadata }] : []),
    ...(capture ? [{ resource: "capture", metadata: capture.metadata }] : []),
  ];
}
