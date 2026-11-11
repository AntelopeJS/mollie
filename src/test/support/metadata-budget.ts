import assert from "node:assert/strict";

import fc from "fast-check";

import {
  type OwnSubscription,
  RoomAfterLaterWrites,
} from "../../implementations/subscriptions/records";
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

/** The longest payment id Mollie gave: 21 characters after the prefix, in test mode in November 2026. */
const LONGEST_PAYMENT_ID = "tr_EMC26Pytk3buxxCzxWQZJ";

/** Mollie's payment ids: ten characters after the prefix, as the stand-in gives, or 21. */
const PaymentIdArb = fc.oneof(
  IdArb.payment,
  IdArb.payment.map((id) => `${id}${id.slice(3)}W`),
  fc.constant(LONGEST_PAYMENT_ID),
);

const EndArb = fc.oneof(InstantArb, fc.constant(LAST_INSTANT));

/** How much caller metadata to pad: any size, or a few bytes either side of the widest write's edge. */
const PadArb = fc.oneof(
  fc.record({ pad: fc.integer({ min: 0, max: MOLLIE_METADATA_BYTES }) }),
  fc.record({ edge: fc.integer({ min: -16, max: 16 }) }),
);

/** The widest write the module may make to `created`: the longest payment id, then a period-end cancellation under the widest key. */
function widestWrite(created: JsonValue): JsonValue {
  const charged = Wire(MergeOwn(created, { firstPayment: LONGEST_PAYMENT_ID }));
  const cancel = {
    timing: "period_end",
    key: WIDEST_CANCEL_KEY,
    endsAt: LAST_INSTANT,
  };
  return Wire(MergeOwn(charged, { cancel }));
}

function padded(
  own: OwnSubscription,
  base: Record<string, string>,
  size: { pad: number } | { edge: number },
) {
  if ("pad" in size) return { ...base, pad: "x".repeat(size.pad) };
  const empty = { ...base, pad: "" };
  const edge =
    MOLLIE_METADATA_BYTES - Bytes(widestWrite(Wire(WriteMetadata(own, empty))));
  return { ...base, pad: "x".repeat(Math.max(0, edge + size.edge)) };
}

/**
 * `docs/4.subscriptions.md` ("Metadata"): with a reference and an idempotency
 * key of up to 64 bytes each, at least 600 bytes are left for the caller.
 */
function isWithinDocumentedRoom(
  own: { reference: string; createKey: string },
  caller: JsonValue,
): boolean {
  return (
    Bytes(own.reference) - 2 <= CANCEL_KEY_BYTES &&
    Bytes(own.createKey) - 2 <= CANCEL_KEY_BYTES &&
    Bytes(caller) <= CALLER_BYTES
  );
}

/**
 * Every subscription `CreateSubscription` creates can be cancelled: the
 * module's later writes to its metadata (the first charge or the refusal,
 * then the cancellation mark, now or at the period end, with a key of up to
 * `CANCEL_KEY_BYTES`) stay within Mollie's 1,024 bytes, whatever caller
 * metadata the creation accepted. Creation accepts what the docs promise
 * room for. An early end after `period_end` writes to the customer, not the
 * subscription.
 */
export const subscriptionWritesFit = fc.property(
  CreatedOwnArb,
  fc.tuple(CallerArb, PadArb),
  fc.tuple(PaymentIdArb, CancelKeyArb, EndArb),
  (own, [base, size], [payment, key, endsAt]) => {
    const caller = padded(own, base, size);
    const created = Wire(WriteMetadata(own, caller));
    const isAccepted = RoomAfterLaterWrites(own, caller) >= 0;
    if (isWithinDocumentedRoom(own, caller)) {
      assert.ok(
        isAccepted,
        `refused ${Bytes(created)} bytes: ${JSON.stringify(own)}`,
      );
    }
    fc.pre(isAccepted);
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
