import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  CANCELLATION_TIMINGS,
  SUBSCRIPTION_INTERVALS,
} from "@antelopejs/interface-subscriptions";
import fc from "fast-check";

import type {
  OwnSubscription,
  StartKind,
} from "../../implementations/subscriptions/records";
import type {
  JsonObject,
  JsonValue,
  MolliePayment,
  MollieRefund,
  MollieSubscription,
} from "../../mollie/types";
import { IsJsonValue } from "../../mollie/json";
import type { MergeOwn, WriteMetadata } from "../../mollie/metadata";
import { LONGEST } from "./calendar-model";

/**
 * Mollie's limit on one resource's metadata: "You can use up to approximately
 * 1kB" (Mollie OpenAPI `metadata`, `github.com/mollie/openapi` `10ce28b`),
 * counted here as UTF-8 bytes of the JSON text.
 */
export const MOLLIE_METADATA_BYTES = 1024;

/** The key every record the module writes keeps its own fields under. */
export const OWN = "antelope";

/** The key the module nests the caller's metadata under. */
export const CALLER = "metadata";

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split("");
const MOLLIE_ID_LENGTH = 10;
const KEY_HASH_LENGTH = 8;
const STARTS: readonly StartKind[] = ["anchor", "charged", "trial"];
const PLAIN = { noNullPrototype: true };
const LAST_INSTANT = Date.UTC(2100, 0, 1);
const LAST_STORED_END = Date.UTC(9999, 11, 31);
const LATEST_DATE = 8.64e15;

/** Strings the read rules could mistake for the module's own or the interface's keys. */
export const TRICKY_KEYS = [
  OWN,
  CALLER,
  "antelopeSubscription",
  "__proto__",
  "constructor",
  "toString",
  "ANTELOPE",
  " spaced key ",
  "",
] as const;

/** Whether `value` is a JSON object: not null, not an array. */
export function IsObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a JSON value is a string. */
export function IsTextValue(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

/** Whether a JSON value is a number. */
export function IsNumberValue(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

/** What a test hands Mollie as metadata: JSON, or what the module's writers return. */
export type Sendable =
  | JsonValue
  | fc.JsonValue
  | ReturnType<typeof WriteMetadata>
  | ReturnType<typeof MergeOwn>;

/** `value` as Mollie stores and returns it: sent as JSON, read back as JSON. */
export function Wire(value: Sendable): JsonValue {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!IsJsonValue(parsed)) {
    throw new TypeError("JSON.parse returned no JSON data");
  }
  return parsed;
}

function parsedJson(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return IsJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The JSON object `metadata` holds: itself when it is an object, the object
 * its text holds when it is a string of JSON, otherwise nothing.
 */
export function ObjectOf(metadata: JsonValue): JsonObject | undefined {
  const holder = IsTextValue(metadata) ? parsedJson(metadata) : metadata;
  return IsObject(holder) ? holder : undefined;
}

/**
 * The module's own object in `metadata`, as the stored format places it: the
 * object under the own key of the metadata object, or of the JSON object a
 * metadata string holds.
 */
export function OwnObjectOf(metadata: JsonValue): JsonObject | undefined {
  const holder = ObjectOf(metadata);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, OWN))
    return undefined;
  const own = holder[OWN];
  return IsObject(own) ? own : undefined;
}

/** The string-valued entries of a JSON object: what a caller sees of metadata another writer left. */
export function StringEntries(object: JsonObject): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object).filter((entry): entry is [string, string] =>
      IsTextValue(entry[1]),
    ),
  );
}

/** The UTF-8 size of `value`'s JSON text, the measure of Mollie's limit. */
export function Bytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * What `docs/4.subscriptions.md` ("Metadata") leaves a subscription's own
 * `metadata` of Mollie's 1 kB: "about 600 bytes", counted as the JSON text of
 * the caller's metadata.
 */
export const CALLER_BYTES = 600;

/**
 * What the same section says the module's own record takes: "up to about 400
 * bytes", counted as the JSON text of the record.
 */
export const OWN_BYTES = 400;

/** The UTF-8 size of the module's own record in `metadata`. */
export function OwnBytes(metadata: JsonValue): number {
  return Bytes(OwnObjectOf(metadata) ?? null);
}

/** A record's own entries in key order, so two records compare whatever their prototype. */
export function Entries(
  record: Readonly<Record<string, JsonValue>>,
): [string, JsonValue][] {
  return Object.entries(record).sort(([first], [second]) =>
    first < second ? -1 : Number(first > second),
  );
}

/** Whether `needle` appears anywhere in `haystack`: the whole value, a field or an item. */
export function Holds(haystack: JsonValue, needle: JsonValue): boolean {
  if (isDeepStrictEqual(haystack, needle)) return true;
  if (Array.isArray(haystack)) {
    return haystack.some((value) => Holds(value, needle));
  }
  if (!IsObject(haystack)) return false;
  return Object.values(haystack).some((value) => Holds(value, needle));
}

/** The first eight hex digits of the key's SHA-256, as an early end stores it. */
export function ExpectedKeyHash(key: string): string {
  return createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, KEY_HASH_LENGTH);
}

function isWritablePeriod(
  interval: JsonValue | undefined,
  count: JsonValue | undefined,
): boolean {
  const known = SUBSCRIPTION_INTERVALS.find((each) => each === interval);
  return (
    known !== undefined &&
    IsNumberValue(count) &&
    Number.isInteger(count) &&
    count >= 1 &&
    count <= LONGEST[known]
  );
}

/**
 * Whether the module could have written this own subscription record: an
 * interval and count the interface accepts within Mollie's longest interval,
 * a known start, and a cancellation end from 1970 to the last day of 9999.
 */
export function IsWritableOwnSubscription(own: OwnSubscription): boolean {
  const endsAt = own.cancel?.endsAt;
  const isEnd =
    endsAt === undefined ||
    (Number.isInteger(endsAt) && endsAt >= 0 && endsAt <= LAST_STORED_END);
  return (
    isWritablePeriod(own.interval, own.intervalCount) &&
    STARTS.includes(own.start) &&
    isEnd
  );
}

/** Whether the own record in `metadata` stores an interval and count the module writes. */
export function StoresWritablePeriod(metadata: JsonValue): boolean {
  const own = OwnObjectOf(metadata);
  return own !== undefined && isWritablePeriod(own.interval, own.intervalCount);
}

function idArb(prefix: string): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...ID_ALPHABET), {
      minLength: MOLLIE_ID_LENGTH,
      maxLength: MOLLIE_ID_LENGTH,
    })
    .map((chars) => `${prefix}_${chars.join("")}`);
}

/** Mollie ids as Mollie writes them: a prefix and ten letters or digits. */
export const IdArb = {
  customer: idArb("cst"),
  payment: idArb("tr"),
  subscription: idArb("sub"),
};

/** Text of any kind, the tricky keys included. */
export const TextArb = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 24 }),
  fc.string({ unit: "binary", maxLength: 12 }),
  fc.constantFrom(...TRICKY_KEYS),
);

/** Text a caller can pass as a reference or an idempotency key: not empty. */
export const KeyArb = TextArb.filter((text) => text.length > 0);

/** Caller metadata as the interfaces type it: string keys to string values. */
export const CallerArb = fc.dictionary(TextArb, TextArb, {
  ...PLAIN,
  maxKeys: 6,
});

/**
 * Caller metadata the way a caller might fill the budget: any entries, then a
 * padding entry that takes a share of the room left, or all of it, which makes
 * the caller's JSON exactly `CALLER_BYTES` long. A caller already past the
 * budget stays past it.
 */
export const CallerWithinBudgetArb = fc
  .tuple(
    CallerArb,
    fc.option(fc.integer({ min: 0, max: CALLER_BYTES }), { nil: undefined }),
  )
  .map(([base, share]) => {
    const room = CALLER_BYTES - Bytes({ ...base, pad: "" });
    if (room < 0) return base;
    return { ...base, pad: "x".repeat(Math.min(share ?? room, room)) };
  });

/** An instant the module stores, as epoch milliseconds. */
export const InstantArb = fc.integer({ min: 0, max: LAST_INSTANT });

const cancelArb = fc.oneof(
  fc.record({ timing: fc.constant("now"), key: KeyArb }, PLAIN),
  fc.record(
    {
      timing: fc.constant("period_end"),
      key: KeyArb,
      endsAt: InstantArb,
    },
    PLAIN,
  ),
);

/** The own subscription record `CreateSubscription` writes and later calls merge into. */
export const OwnSubscriptionArb: fc.Arbitrary<OwnSubscription> = fc
  .constantFrom(...SUBSCRIPTION_INTERVALS)
  .chain((interval) =>
    fc.record(
      {
        reference: KeyArb,
        createKey: KeyArb,
        interval: fc.constant(interval),
        intervalCount: fc.integer({ min: 1, max: LONGEST[interval] }),
        start: fc.constantFrom(...STARTS),
        firstPayment: IdArb.payment,
        refused: IdArb.payment,
        cancel: cancelArb,
      },
      {
        ...PLAIN,
        requiredKeys: [
          "reference",
          "createKey",
          "interval",
          "intervalCount",
          "start",
        ],
      },
    ),
  );

const OddNumberArb = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);

const OddEndArb = fc.oneof(
  OddNumberArb,
  fc.integer({ min: LAST_STORED_END - 1, max: LATEST_DATE }),
);

/**
 * An own subscription record another writer changed: well-typed, with any
 * number as its interval count and cancellation end, the instants past the
 * last day of 9999 that a `Date` still holds included.
 */
export const TamperedOwnSubscriptionArb: fc.Arbitrary<JsonValue> = fc
  .tuple(OwnSubscriptionArb, OddNumberArb, OddEndArb)
  .map(([own, intervalCount, endsAt]) => {
    const tampered: OwnSubscription = { ...own, intervalCount };
    if (own.cancel) tampered.cancel = { ...own.cancel, endsAt };
    return Wire({ [OWN]: tampered, [CALLER]: {} });
  });

/** One early end as a customer's metadata stores it: end time and key hash. */
export const EarlyEndArb = fc.tuple(InstantArb, KeyArb.map(ExpectedKeyHash));

/** A customer's early ends by Mollie subscription id. */
export const EarlyEndsArb = fc.dictionary(IdArb.subscription, EarlyEndArb, {
  ...PLAIN,
  maxKeys: 4,
});

/** Each own record the module writes, by the resource it writes it on. */
export const OwnRecordArb = fc.oneof(
  fc
    .record({ reference: KeyArb }, PLAIN)
    .map((own) => ({ kind: "payment", own })),
  fc
    .record({ reference: KeyArb, subscription: KeyArb }, PLAIN)
    .map((own) => ({ kind: "charge", own })),
  fc.record({ key: KeyArb }, PLAIN).map((own) => ({ kind: "capture", own })),
  fc
    .record(
      { key: KeyArb, reason: KeyArb },
      { ...PLAIN, requiredKeys: ["key"] },
    )
    .map((own) => ({ kind: "refund", own })),
  fc.constant({ kind: "customer", own: {} }),
  EarlyEndsArb.map((endedEarly) => ({ kind: "customer", own: { endedEarly } })),
  OwnSubscriptionArb.map((own) => ({ kind: "subscription", own })),
);

/** What the module merges into its own record: one of the changes its calls make. */
export const ChangesArb: fc.Arbitrary<JsonObject> = fc.oneof(
  IdArb.payment.map((firstPayment) => ({ firstPayment })),
  IdArb.payment.map((refused) => ({ refused })),
  cancelArb.map((cancel) => ({ cancel })),
  EarlyEndsArb.map((endedEarly) => ({ endedEarly })),
);

const ForeignValueArb = fc.jsonValue({ maxDepth: 2 }).map(Wire);

/** A JSON object another writer left, without the module's key. */
export const ForeignObjectArb: fc.Arbitrary<JsonObject> = fc.dictionary(
  TextArb.filter((key) => key !== OWN),
  ForeignValueArb,
  { ...PLAIN, minKeys: 1, maxKeys: 5 },
);

/**
 * Metadata another writer left with no `antelope` key: a JSON object, one with
 * a `metadata` object of its own, or either as the text of its JSON.
 */
const ForeignWithCallerArb: fc.Arbitrary<JsonObject> = fc
  .tuple(
    ForeignObjectArb,
    fc.oneof(
      CallerArb,
      fc.dictionary(TextArb, ForeignValueArb, { ...PLAIN, maxKeys: 4 }),
    ),
  )
  .map(([foreign, nested]) => ({ ...foreign, [CALLER]: nested }));

export const ForeignCallerArb: fc.Arbitrary<JsonValue> = fc.oneof(
  ForeignObjectArb,
  ForeignWithCallerArb,
  ForeignObjectArb.map((object) => JSON.stringify(object)),
  ForeignWithCallerArb.map((object) => JSON.stringify(object)),
);

/** Metadata Mollie accepts that is not a JSON object: a string, a number or a list of strings. */
export const NonObjectArb: fc.Arbitrary<JsonValue> = fc.oneof(
  KeyArb,
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map(Wire),
  fc.array(TextArb, { minLength: 1, maxLength: 4 }),
);

/** A metadata string that is not the JSON text of an object: JSON of another type, or text that is not JSON. */
export const NonObjectTextArb: fc.Arbitrary<string> = fc
  .oneof(
    NonObjectArb.map((value) => JSON.stringify(value)),
    fc.array(TextArb, { maxLength: 3 }).map((items) => JSON.stringify(items)),
    TextArb,
  )
  .filter((text) => ObjectOf(text) === undefined);

/** An own record of the wrong shape: a value of another type, or an object with fields of other types. */
const ForeignOwnArb = fc.oneof(
  ForeignValueArb,
  fc.dictionary(
    fc.constantFrom(
      "reference",
      "createKey",
      "interval",
      "intervalCount",
      "start",
      "firstPayment",
      "refused",
      "cancel",
      "subscription",
      "key",
      "endedEarly",
    ),
    ForeignValueArb,
  ),
);

const OWN_SUBSCRIPTION_FIELDS = [
  "reference",
  "createKey",
  "interval",
  "intervalCount",
  "start",
  "firstPayment",
  "refused",
  "cancel",
] as const;

/** A well-formed own subscription record with one field holding a value of any type. */
const MistypedOwnSubscriptionArb: fc.Arbitrary<JsonValue> = fc
  .tuple(
    OwnSubscriptionArb,
    fc.constantFrom(...OWN_SUBSCRIPTION_FIELDS),
    ForeignValueArb,
  )
  .map(([own, field, value]) => {
    const stored = Wire({ [OWN]: own, [CALLER]: {} });
    const record = IsObject(stored) ? stored[OWN] : undefined;
    if (IsObject(record)) record[field] = value;
    return stored;
  });

const CancelFieldArb: fc.Arbitrary<[string, JsonValue]> = fc.oneof(
  fc.tuple(
    fc.constant("timing"),
    fc
      .oneof(
        fc.string({ maxLength: 12 }),
        fc.constantFrom("NOW", "Period_End", "period-end", "period_end ", ""),
      )
      .filter(
        (text) => !CANCELLATION_TIMINGS.some((timing) => timing === text),
      ),
  ),
  fc.tuple(fc.constant("key"), ForeignValueArb),
  fc.tuple(fc.constant("endsAt"), ForeignValueArb),
);

/**
 * A well-formed own subscription record whose cancellation mark has one field
 * holding a value of another type, or a timing the interface does not know,
 * the mark's other fields valid.
 */
const MistypedCancelArb: fc.Arbitrary<JsonValue> = fc
  .tuple(OwnSubscriptionArb, cancelArb, CancelFieldArb)
  .map(([own, cancel, [field, value]]) => {
    const stored = Wire({ [OWN]: { ...own, cancel }, [CALLER]: {} });
    const record = IsObject(stored) ? stored[OWN] : undefined;
    const mark = IsObject(record) ? record.cancel : undefined;
    if (IsObject(mark)) mark[field] = value;
    return stored;
  });

/** Any metadata a resource can carry: arbitrary JSON, foreign records and the module's own. */
export const AnyMetadataArb: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.jsonValue({ maxDepth: 3 }).map(Wire),
  MistypedOwnSubscriptionArb,
  { arbitrary: MistypedCancelArb, weight: 2 },
  ForeignCallerArb,
  NonObjectArb,
  ForeignObjectArb,
  fc.record({ [OWN]: ForeignOwnArb, [CALLER]: ForeignValueArb }),
  fc
    .tuple(ForeignObjectArb, ForeignOwnArb)
    .map(([foreign, own]) => ({ ...foreign, [OWN]: own })),
  OwnRecordArb.chain(({ own }) =>
    CallerArb.map((caller) => Wire({ [OWN]: own, [CALLER]: caller })),
  ),
  ForeignValueArb.map((value) => JSON.stringify(value)),
);

const AMOUNT = { currency: "EUR", value: "10.00" };
const CREATED_AT = "2026-01-14T10:00:00+00:00";

/** A Mollie payment carrying `metadata`, with no customer or subscription. */
export function PaymentWith(metadata: JsonValue): MolliePayment {
  return {
    resource: "payment",
    id: "tr_property01",
    mode: "test",
    description: "property",
    amount: AMOUNT,
    status: "paid",
    sequenceType: "oneoff",
    metadata,
    createdAt: CREATED_AT,
    _links: {},
  };
}

/** A Mollie refund carrying `metadata`. */
export function RefundWith(metadata: JsonValue): MollieRefund {
  return {
    resource: "refund",
    id: "re_property01",
    amount: AMOUNT,
    status: "refunded",
    paymentId: "tr_property01",
    metadata,
    createdAt: CREATED_AT,
  };
}

/** Subscription statuses Mollie reports. */
export const MOLLIE_SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "canceled",
  "suspended",
  "completed",
] as const;

/** A Mollie subscription carrying `metadata`, monthly from 2026-01-15. */
export function SubscriptionWith(
  metadata: JsonValue,
  status: MollieSubscription["status"] = "active",
): MollieSubscription {
  const isEnded = status === "canceled" || status === "completed";
  return {
    resource: "subscription",
    id: "sub_property01",
    status,
    amount: AMOUNT,
    interval: "1 month",
    startDate: "2026-01-15",
    nextPaymentDate: isEnded ? null : "2026-12-15",
    description: "property",
    metadata,
    customerId: "cst_property01",
    createdAt: CREATED_AT,
    canceledAt: isEnded ? "2026-06-01T10:00:00+00:00" : null,
  };
}
