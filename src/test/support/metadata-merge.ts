import assert from "node:assert/strict";

import fc from "fast-check";

import { ReadOwnSubscription } from "../../implementations/subscriptions/records";
import {
  FitsMetadataLimit,
  MergeOwn,
  ReadCallerMetadata,
  WriteMetadata,
} from "../../mollie/metadata";
import type { JsonValue } from "../../mollie/types";
import {
  Bytes,
  CallerArb,
  EarlyEndsArb,
  Entries,
  Holds,
  CALLER,
  IdArb,
  IsObject,
  MOLLIE_METADATA_BYTES,
  ObjectOf,
  ObjectTextArb,
  OwnSubscriptionArb,
  SubscriptionWith,
  Wire,
} from "./metadata-model";

const NEAR_LIMIT = { min: 850, max: 1000 };

/**
 * Metadata of another writer sized around Mollie's limit: strings of one to
 * four bytes per character, a string and an object holding a long entry, and
 * an object with a `metadata` object of its own that the merge marks foreign.
 */
export const NearLimitArb: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string({ unit: "binary", minLength: 400, maxLength: 1100 }),
  fc.string({ unit: "grapheme", minLength: 250, maxLength: 700 }),
  fc
    .integer(NEAR_LIMIT)
    .map((length) => JSON.stringify({ crm: "a".repeat(length) })),
  fc.integer(NEAR_LIMIT).map((length) => ({ crm: "a".repeat(length) })),
  fc
    .integer(NEAR_LIMIT)
    .map((length) => ({ crm: "a".repeat(length), metadata: {} })),
);

/**
 * Metadata the module wrote, stored by another writer as the JSON text of
 * what it read, then merged into: the text is kept as it is, the caller reads
 * what it read, and the own record still reads from the text.
 */
export const mergeKeepsOwnText = fc.property(
  OwnSubscriptionArb,
  CallerArb,
  IdArb.payment,
  (own, caller, firstPayment) => {
    const text = JSON.stringify(WriteMetadata(own, caller));
    const merged = Wire(MergeOwn(text, { firstPayment }));
    assert.ok(Holds(merged, text), "the merge dropped the text");
    assert.deepEqual(Entries(ReadCallerMetadata(merged)), Entries(caller));
    assert.deepEqual(ReadOwnSubscription(SubscriptionWith(merged)), {
      ...own,
      firstPayment,
    });
  },
);

/**
 * `FitsMetadataLimit` tells a merged early end that fits Mollie's limit from
 * one that does not by the UTF-8 bytes of its JSON text, whatever the
 * metadata merged into.
 */
export const mergeIsSizeChecked = fc.property(
  NearLimitArb,
  EarlyEndsArb,
  (foreign, endedEarly) => {
    const merged = MergeOwn(foreign, { endedEarly });
    const size = Bytes(Wire(merged));
    assert.equal(
      FitsMetadataLimit(merged),
      size <= MOLLIE_METADATA_BYTES,
      `${size} bytes`,
    );
  },
);

/** Fails when the generators of the merge properties lose a class of input they need. */
export function AssertMergeInputs(parameters: {
  seed: number;
  numRuns: number;
}): void {
  assert.ok(
    fc
      .sample(ObjectTextArb, parameters)
      .some((text) => IsObject(ObjectOf(text)?.[CALLER])),
    "no JSON object text with a metadata object of its own",
  );
  const sizes = fc
    .sample(NearLimitArb, parameters)
    .map((value) => Bytes(Wire(MergeOwn(value, { endedEarly: {} }))));
  assert.ok(sizes.some((size) => size <= MOLLIE_METADATA_BYTES));
  assert.ok(sizes.some((size) => size > MOLLIE_METADATA_BYTES));
}
