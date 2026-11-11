import assert from "node:assert/strict";

import fc from "fast-check";

import { MergeOwn, WriteMetadata } from "../../mollie/metadata";
import type { JsonValue } from "../../mollie/types";
import {
  Bytes,
  CALLER_BYTES,
  CallerArb,
  CallerWithinBudgetArb,
  EarlyEndArb,
  IdArb,
  InstantArb,
  KeyArb,
  MOLLIE_METADATA_BYTES,
  OWN_BYTES,
  OwnBytes,
  OwnObjectOf,
  OwnSubscriptionArb,
  Wire,
} from "./metadata-model";

const EARLY_ENDS = 20;
const LAST_INSTANT = 4102444800000;

/** The longest text of the documented budget: twelve characters of JSON `\u0000`, 72 bytes. */
export const WIDEST_KEY = "\u0000".repeat(12);

const BudgetKeyArb = fc.oneof(KeyArb, fc.constant(WIDEST_KEY));

const CreatedOwnArb = fc
  .tuple(OwnSubscriptionArb, BudgetKeyArb, BudgetKeyArb)
  .map(([{ interval, intervalCount, start }, reference, createKey]) => ({
    reference,
    createKey,
    interval,
    intervalCount,
    start,
  }));

/**
 * A subscription at the edge of the documented budget: 600 bytes of caller
 * metadata, the widest keys, a first charge and a cancellation at the period end.
 */
export function WidestSubscription() {
  const caller = { pad: "x".repeat(CALLER_BYTES - Bytes({ pad: "" })) };
  const own = {
    reference: WIDEST_KEY,
    createKey: WIDEST_KEY,
    interval: "month",
    intervalCount: 1,
    start: "charged",
  };
  const charged = Wire(
    MergeOwn(Wire(WriteMetadata(own, caller)), {
      firstPayment: "tr_AAAAAAAAAA",
    }),
  );
  const cancel = {
    timing: "period_end",
    key: WIDEST_KEY,
    endsAt: LAST_INSTANT,
  };
  return { caller, canceled: Wire(MergeOwn(charged, { cancel })) };
}

/**
 * `docs/4.subscriptions.md` ("Metadata"): the module's own record takes up to
 * about 400 bytes of a subscription's 1 kB and leaves about 600 for the
 * caller's metadata. Inside that budget, no write the module makes later
 * (the first charge or the refusal, then a cancellation now or at the period
 * end) takes the metadata past Mollie's 1 kB. The docs promise nothing beyond
 * the budget, so the property discards what is outside it.
 */
export const laterWritesFit = fc.property(
  CreatedOwnArb,
  CallerWithinBudgetArb,
  fc.tuple(IdArb.payment, BudgetKeyArb, InstantArb),
  (own, caller, [payment, key, endsAt]) => {
    const created = Wire(WriteMetadata(own, caller));
    const cancels = [
      { timing: "now", key },
      { timing: "period_end", key, endsAt },
    ];
    const marks = [{ firstPayment: payment }, { refused: payment }];
    const writes = marks.flatMap((mark) => {
      const marked = Wire(MergeOwn(created, mark));
      return [
        marked,
        ...cancels.map((cancel) => Wire(MergeOwn(marked, { cancel }))),
      ];
    });
    fc.pre(Bytes(caller) <= CALLER_BYTES);
    fc.pre(writes.every((written) => OwnBytes(written) <= OWN_BYTES));
    for (const written of [created, ...writes]) {
      assert.ok(
        Bytes(written) <= MOLLIE_METADATA_BYTES,
        `${Bytes(caller)} caller bytes and ${OwnBytes(written)} own bytes make ${Bytes(written)}: ${JSON.stringify(written)}`,
      );
    }
  },
);

/**
 * The longest cancellation key the subscription's metadata must keep room for,
 * as UTF-8 bytes of its JSON text without the quotes. The interface bounds no
 * idempotency key, and the cancellation key is only known when the caller
 * cancels, so creation can keep room for a key of some size only. A UUID takes
 * 36 bytes.
 */
const CANCEL_KEY_BYTES = 64;

/** A cancellation key of exactly `CANCEL_KEY_BYTES`, most of it escaped in JSON. */
const WIDEST_CANCEL_KEY = `${"\u0000".repeat(10)}xxxx`;

const CancelKeyArb = fc.oneof(
  KeyArb.filter((key) => Bytes(key) - 2 <= CANCEL_KEY_BYTES),
  fc.constant(WIDEST_CANCEL_KEY),
);

/** Caller metadata of any size up to what Mollie accepts with an own record beside it. */
const CallerOfAnySizeArb = fc
  .tuple(CallerArb, fc.integer({ min: 0, max: MOLLIE_METADATA_BYTES }))
  .map(([base, pad]) => ({ ...base, pad: "x".repeat(pad) }));

/** Whether `CreateSubscription` sends the metadata to Mollie and Mollie stores it. */
function isCreated(created: JsonValue): boolean {
  return Bytes(created) <= MOLLIE_METADATA_BYTES;
}

/**
 * Every subscription `CreateSubscription` creates can be cancelled: the
 * module's later writes to its metadata (the first charge or the refusal,
 * then the cancellation mark, now or at the period end, with a key of up to
 * `CANCEL_KEY_BYTES`) stay within Mollie's 1,024 bytes, whatever caller
 * metadata the creation accepted. An early end after `period_end` writes to
 * the customer, not the subscription.
 */
export const subscriptionWritesFit = fc.property(
  CreatedOwnArb,
  CallerOfAnySizeArb,
  fc.tuple(IdArb.payment, CancelKeyArb, InstantArb),
  (own, caller, [payment, key, endsAt]) => {
    const created = Wire(WriteMetadata(own, caller));
    fc.pre(isCreated(created));
    const cancels = [
      { timing: "now", key },
      { timing: "period_end", key, endsAt },
    ];
    for (const mark of [{ firstPayment: payment }, { refused: payment }]) {
      const marked = Wire(MergeOwn(created, mark));
      for (const written of [
        marked,
        ...cancels.map((cancel) => Wire(MergeOwn(marked, { cancel }))),
      ]) {
        assert.ok(
          Bytes(written) <= MOLLIE_METADATA_BYTES,
          `created at ${Bytes(created)} bytes with ${Bytes(caller)} caller bytes, written at ${Bytes(written)}: ${JSON.stringify(OwnObjectOf(written))}`,
        );
      }
    }
  },
);

/**
 * `docs/4.subscriptions.md` ("Cancelling", `now` after `period_end`): a customer has room for "about twenty"
 * early ends, each recorded in the customer's metadata. Twenty fit a customer
 * with no other metadata.
 */
export const earlyEndsFit = fc.property(
  fc.uniqueArray(fc.tuple(IdArb.subscription, EarlyEndArb), {
    minLength: EARLY_ENDS,
    maxLength: EARLY_ENDS,
    selector: ([id]) => id,
  }),
  (ends) => {
    const customer = Wire(
      MergeOwn(Wire(WriteMetadata({})), {
        endedEarly: Object.fromEntries(ends),
      }),
    );
    assert.ok(
      Bytes(customer) <= MOLLIE_METADATA_BYTES,
      `${EARLY_ENDS} early ends make ${Bytes(customer)} bytes`,
    );
  },
);
