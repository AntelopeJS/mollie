import assert from "node:assert/strict";

import {
  CANCELLATION_TIMINGS,
  SubscriptionError,
} from "@antelopejs/interface-subscriptions";
import fc from "fast-check";

import type { Account } from "../accounts";
import { ToPayment, ToRefund } from "../implementations/payment/mapping";
import { SubscriptionOfPayment } from "../implementations/shared/subscription-of-payment";
import { ToSubscription } from "../implementations/subscriptions/mapping";
import {
  type OwnSubscription,
  ReadOwnSubscription,
  ShownSubscription,
} from "../implementations/subscriptions/records";
import { MollieClient } from "../mollie/client";
import {
  MergeOwn,
  ReadCallerMetadata,
  WriteMetadata,
} from "../mollie/metadata";
import type { JsonValue, MollieSubscription } from "../mollie/types";
import {
  AnyMetadataArb,
  Bytes,
  CALLER,
  CALLER_BYTES,
  CallerArb,
  ChangesArb,
  Entries,
  ForeignCallerArb,
  ForeignObjectArb,
  Holds,
  IsObject,
  IsNumberValue,
  IsTextValue,
  IsWritableOwnSubscription,
  KeyArb,
  MOLLIE_SUBSCRIPTION_STATUSES,
  NonObjectArb,
  NonObjectTextArb,
  ObjectOf,
  ObjectTextArb,
  OWN,
  OwnBytes,
  OwnObjectOf,
  OwnRecordArb,
  OwnSubscriptionArb,
  PaymentWith,
  RefundWith,
  StoresWritablePeriod,
  StringEntries,
  SubscriptionWith,
  TamperedOwnSubscriptionArb,
  Wire,
} from "./support/metadata-model";
import {
  earlyEndsFit,
  laterWritesFit,
  WidestSubscription,
} from "./support/metadata-budget";
import {
  AssertMergeInputs,
  mergeIsSizeChecked,
  mergeKeepsOwnText,
} from "./support/metadata-merge";
import { AssertOwnTypes } from "./support/metadata-types";
import {
  IsDocumentedMollieInterval,
  MollieIntervalArb,
} from "./support/calendar-model";

const DEFAULT_SEED = 20261111;
const RUNS = 300;
const SUITE_TIMEOUT_MS = 60_000;
const NOW = Date.parse("2026-11-11T12:00:00Z");
const SUBSCRIPTION_ID = "cst_property01:sub_property01";
const READ_OWN: OwnSubscription = {
  reference: "property",
  interval: "month",
  intervalCount: 1,
  start: "anchor",
};

const requestedSeed = Number.parseInt(process.env.FC_SEED ?? "", 10);
const PARAMETERS = {
  seed: Number.isInteger(requestedSeed) ? requestedSeed : DEFAULT_SEED,
  numRuns: RUNS,
};

const OFFLINE: Account = {
  client: new MollieClient({
    apiKey: `test_${"x".repeat(30)}`,
    apiUrl: "http://127.0.0.1:9",
  }),
  settleTimeoutMs: 0,
};

function isEnded(status: MollieSubscription["status"]): boolean {
  return status === "canceled" || status === "completed";
}

function assertCaller(
  read: Record<string, string> | undefined,
  caller: Record<string, string>,
): void {
  const expected = Entries(caller);
  assert.deepEqual(Entries(read ?? {}), expected);
  assert.equal(
    read === undefined,
    expected.length === 0,
    "an empty caller metadata reads as absent, any other as present",
  );
}

const callerRoundTrip = fc.property(
  OwnRecordArb,
  CallerArb,
  ({ own }, caller) => {
    const stored = Wire(WriteMetadata(own, caller));
    assert.deepEqual(Entries(ReadCallerMetadata(stored)), Entries(caller));
    assertCaller(ToPayment(PaymentWith(stored)).metadata, caller);
    assertCaller(ToRefund(RefundWith(stored)).metadata, caller);
    const record = {
      id: SUBSCRIPTION_ID,
      mollie: SubscriptionWith(stored),
      own: READ_OWN,
    };
    assertCaller(ToSubscription(record, NOW).metadata, caller);
  },
);

const ownRoundTrip = fc.asyncProperty(
  OwnSubscriptionArb,
  CallerArb,
  fc.constantFrom(...MOLLIE_SUBSCRIPTION_STATUSES),
  fc.tuple(KeyArb, KeyArb),
  async (own, caller, status, [reference, subscription]) => {
    const mollie = SubscriptionWith(Wire(WriteMetadata(own, caller)), status);
    assert.deepEqual(ReadOwnSubscription(mollie), own);
    const isRefusalDone =
      own.refused !== undefined && own.cancel === undefined && isEnded(status);
    assert.deepEqual(
      ShownSubscription(mollie),
      isRefusalDone ? undefined : own,
    );
    const renewal = PaymentWith(mollie.metadata ?? null);
    assert.equal(ToPayment(renewal).reference, own.reference);
    const payment = PaymentWith(Wire(WriteMetadata({ reference }, caller)));
    assert.equal(ToPayment(payment).reference, reference);
    const charge = PaymentWith(
      Wire(WriteMetadata({ reference, subscription })),
    );
    assert.equal(ToPayment(charge).reference, reference);
    assert.deepEqual(await SubscriptionOfPayment(OFFLINE, charge), {
      id: subscription,
    });
  },
);

const ModuleWrittenArb = OwnRecordArb.chain(({ own }) =>
  CallerArb.map((caller) => Wire(WriteMetadata(own, caller))),
);

const MergeBaseArb = fc.oneof(
  ModuleWrittenArb,
  ForeignObjectArb,
  fc
    .tuple(ForeignObjectArb, ForeignObjectArb)
    .map(([foreign, own]) => ({ ...foreign, [OWN]: own })),
  fc
    .tuple(ForeignObjectArb, fc.jsonValue({ maxDepth: 1 }).map(Wire))
    .map(([foreign, own]) => ({ ...foreign, [OWN]: own })),
);

const mergeKeepsForeignKeys = fc.property(
  MergeBaseArb,
  ChangesArb,
  (base, changes) => {
    const before = Wire(base);
    const merged = Wire(MergeOwn(before, changes));
    const wanted = changes;
    assert.ok(IsObject(before) && IsObject(merged) && IsObject(wanted));
    const ownBefore = IsObject(before[OWN]) ? before[OWN] : {};
    const isForeign = !(OWN in before) && IsObject(before[CALLER]);
    const marks: Record<string, JsonValue> = isForeign ? { foreign: true } : {};
    const ownAfter = merged[OWN];
    assert.ok(IsObject(ownAfter), "the merged own record is an object");
    assert.deepEqual(
      Object.keys(merged).sort(),
      [...new Set([...Object.keys(before), OWN])].sort(),
    );
    for (const [key, value] of Object.entries(before)) {
      if (key !== OWN) assert.deepEqual(merged[key], value, `${key} changed`);
    }
    assert.deepEqual(
      Entries(ownAfter),
      Entries({ ...ownBefore, ...marks, ...wanted }),
    );
  },
);

const mergeKeepsCallerView = fc.property(
  OwnRecordArb,
  CallerArb,
  ChangesArb,
  ({ own }, caller, changes) => {
    const stored = Wire(WriteMetadata(own, caller));
    const merged = Wire(MergeOwn(stored, changes));
    assert.deepEqual(Entries(ReadCallerMetadata(merged)), Entries(caller));
  },
);

const mergeKeepsForeignCallerView = fc.property(
  ForeignObjectArb,
  ChangesArb,
  (foreign, changes) => {
    const expected = Entries(StringEntries(foreign));
    assert.deepEqual(Entries(ReadCallerMetadata(foreign)), expected);
    const merged = Wire(MergeOwn(foreign, changes));
    assert.deepEqual(
      Entries(ReadCallerMetadata(merged)),
      expected,
      "the merge changed what the caller sees",
    );
  },
);

const mergeKeepsForeignValue = fc.property(
  fc.oneof(NonObjectArb, ObjectTextArb),
  ChangesArb,
  (foreign, changes) => {
    const merged = Wire(MergeOwn(foreign, changes));
    assert.ok(
      Holds(merged, foreign),
      `the merge dropped ${JSON.stringify(foreign)}: ${JSON.stringify(merged)}`,
    );
    assert.deepEqual(
      Entries(ReadCallerMetadata(merged)),
      Entries(ReadCallerMetadata(foreign)),
      "the merge changed what the caller reads",
    );
  },
);

const readsNeverThrow = fc.asyncProperty(
  AnyMetadataArb,
  fc.constantFrom(...MOLLIE_SUBSCRIPTION_STATUSES),
  async (metadata, status) => {
    const caller = ReadCallerMetadata(metadata);
    assert.ok(Object.values(caller).every(IsTextValue));
    const payment = ToPayment(PaymentWith(metadata));
    assert.ok(IsTextValue(payment.reference));
    const refund = ToRefund(RefundWith(metadata));
    assert.deepEqual(Entries(refund.metadata ?? {}), Entries(caller));
    const mollie = SubscriptionWith(metadata, status);
    const own = ReadOwnSubscription(mollie);
    if (own) AssertOwnTypes(own);
    const shown = ShownSubscription(mollie);
    if (shown !== undefined) assert.deepEqual(shown, own);
    const charged = await SubscriptionOfPayment(OFFLINE, PaymentWith(metadata));
    assert.ok(charged === undefined || IsTextValue(charged.id));
    if (OwnObjectOf(metadata) === undefined) {
      assert.equal(
        own,
        undefined,
        "a record without an own object reads as ours",
      );
      assert.equal(payment.reference, "");
      assert.equal(charged, undefined);
    }
  },
);

function readOwnOrError(
  mollie: MollieSubscription,
): OwnSubscription | SubscriptionError | undefined {
  try {
    return ReadOwnSubscription(mollie);
  } catch (error) {
    assert.ok(error instanceof SubscriptionError, String(error));
    return error;
  }
}

const ownSubscriptionValues = fc.property(
  fc.oneof(AnyMetadataArb, TamperedOwnSubscriptionArb),
  MollieIntervalArb,
  (metadata: JsonValue, interval: string) => {
    const read = readOwnOrError({ ...SubscriptionWith(metadata), interval });
    if (read instanceof SubscriptionError) {
      assert.ok(
        !StoresWritablePeriod(metadata) &&
          !IsDocumentedMollieInterval(interval),
        `refused a subscription with a readable period: ${read.message}`,
      );
      assert.ok(read.message.includes(SUBSCRIPTION_ID), read.message);
      return;
    }
    if (!read) return;
    assert.ok(
      IsWritableOwnSubscription(read),
      `the module reads an own record it never writes: ${JSON.stringify(read)}`,
    );
  },
);

const foreignCallerView = fc.property(ForeignCallerArb, (foreign) => {
  const object = ObjectOf(foreign);
  assert.ok(object, "another writer's metadata is a JSON object");
  const caller = StringEntries(object);
  assert.deepEqual(Entries(ReadCallerMetadata(foreign)), Entries(caller));
  assertCaller(ToPayment(PaymentWith(foreign)).metadata, caller);
  assertCaller(ToRefund(RefundWith(foreign)).metadata, caller);
  const mollie = SubscriptionWith(foreign);
  assert.equal(ReadOwnSubscription(mollie), undefined);
  const record = { id: SUBSCRIPTION_ID, mollie, own: READ_OWN };
  assertCaller(ToSubscription(record, NOW).metadata, caller);
});

const textRoundTrip = fc.asyncProperty(
  OwnSubscriptionArb,
  CallerArb,
  fc.tuple(KeyArb, KeyArb),
  async (own, caller, [reference, subscription]) => {
    const text = JSON.stringify(WriteMetadata(own, caller));
    assert.deepEqual(Entries(ReadCallerMetadata(text)), Entries(caller));
    assertCaller(ToPayment(PaymentWith(text)).metadata, caller);
    assertCaller(ToRefund(RefundWith(text)).metadata, caller);
    assert.deepEqual(ReadOwnSubscription(SubscriptionWith(text)), own);
    const charge = PaymentWith(
      JSON.stringify(WriteMetadata({ reference, subscription }, caller)),
    );
    assert.equal(ToPayment(charge).reference, reference);
    assert.deepEqual(await SubscriptionOfPayment(OFFLINE, charge), {
      id: subscription,
    });
  },
);

const textWithoutObject = fc.asyncProperty(NonObjectTextArb, async (text) => {
  assert.deepEqual(Entries(ReadCallerMetadata(text)), []);
  assert.equal(ReadOwnSubscription(SubscriptionWith(text)), undefined);
  const payment = ToPayment(PaymentWith(text));
  assert.equal(payment.reference, "");
  assert.equal(payment.metadata, undefined);
  assert.equal(
    await SubscriptionOfPayment(OFFLINE, PaymentWith(text)),
    undefined,
  );
});

function holds<Ts extends unknown[]>(
  name: string,
  claim: string,
  property: fc.IRawProperty<Ts>,
) {
  it(`holds ${name}: ${claim}`, async () => {
    const details = await fc.check(property, PARAMETERS);
    assert.ok(!details.failed, fc.defaultReportMessage(details));
  });
}

function finding<Ts extends unknown[]>(
  name: string,
  claim: string,
  property: fc.IRawProperty<Ts>,
) {
  it(`finding ${name}: ${claim}`, async () => {
    const details = await fc.check(property, PARAMETERS);
    assert.ok(details.failed, `${name} now holds: record it as holds`);
  });
}

describe("[mollie] metadata round trip properties", function () {
  this.timeout(SUITE_TIMEOUT_MS);

  holds(
    "callerRoundTrip",
    "the caller's metadata reads back unchanged next to every own record, the module's key names included",
    callerRoundTrip,
  );
  holds(
    "ownRoundTrip",
    "every own subscription, payment and charge record reads back as written",
    ownRoundTrip,
  );
  holds(
    "mergeKeepsForeignKeys",
    "a merge into a JSON object keeps every other key and every own field it does not change, and marks another writer's object that holds a metadata object",
    mergeKeepsForeignKeys,
  );
  holds(
    "mergeKeepsCallerView",
    "a merge into metadata the module wrote leaves the caller's metadata as it reads",
    mergeKeepsCallerView,
  );
  holds(
    "mergeKeepsForeignCallerView",
    "a merge into another writer's JSON object leaves its string entries as the caller reads them",
    mergeKeepsForeignCallerView,
  );
  holds(
    "mergeKeepsForeignValue",
    "a merge into a string, whether or not it holds a JSON object, or into any other metadata that is not an object, keeps it as it is, and the caller reads what it read",
    mergeKeepsForeignValue,
  );
  holds(
    "mergeKeepsOwnText",
    "a merge into the JSON text of the module's own record keeps the text, and the caller and the own record read as before",
    mergeKeepsOwnText,
  );
  holds(
    "mergeIsSizeChecked",
    "whatever metadata an early end is merged into, the module's size check agrees with the UTF-8 bytes of the merged JSON text against Mollie's 1 kB",
    mergeIsSizeChecked,
  );
  holds(
    "readsNeverThrow",
    "every metadata reader returns its documented types for any JSON, and a record without an own object is not the module's",
    readsNeverThrow,
  );
  holds(
    "ownSubscriptionValues",
    "an own subscription record the module accepts has values the module writes",
    ownSubscriptionValues,
  );
  holds(
    "foreignCallerView",
    "metadata with no `antelope` key, one with a `metadata` object of its own and the text of either included, reads as its own string entries",
    foreignCallerView,
  );
  holds(
    "textRoundTrip",
    "metadata Mollie holds as the JSON text of what the module wrote reads as the object",
    textRoundTrip,
  );
  holds(
    "textWithoutObject",
    "a metadata string that is not the JSON text of an object reads as no metadata and not the module's",
    textWithoutObject,
  );
  holds(
    "laterWritesFit",
    "caller metadata within the documented 600 bytes and an own record within 400 stay within Mollie's 1 kB after the first charge, the refusal and a cancellation",
    laterWritesFit,
  );
  holds(
    "earlyEndsFit",
    "twenty early ends fit a customer's 1 kB",
    earlyEndsFit,
  );
});

describe("[mollie] metadata generators and pinned findings", () => {
  it("generates the module's key names as caller keys, foreign own records, metadata that is not an object and impossible counts", () => {
    const hasKey = (record: JsonValue, key: string) =>
      IsObject(record) && Object.prototype.hasOwnProperty.call(record, key);
    const callers = fc.sample(CallerArb, PARAMETERS);
    for (const key of [OWN, "metadata", "antelopeSubscription", "__proto__"]) {
      assert.ok(
        callers.some((caller) => hasKey(caller, key)),
        `no caller key ${key}`,
      );
    }
    const metadata = fc.sample(AnyMetadataArb, PARAMETERS);
    assert.ok(metadata.some((value) => OwnObjectOf(value) !== undefined));
    assert.ok(
      metadata.some(
        (value) => hasKey(value, OWN) && OwnObjectOf(value) === undefined,
      ),
      "no foreign value under the own key",
    );
    assert.ok(
      metadata.some((value) => IsTextValue(value)),
      "no string metadata",
    );
    assert.ok(
      metadata.some((value) => Array.isArray(value)),
      "no list metadata",
    );
    const marks = metadata.map((value) => OwnObjectOf(value)?.cancel);
    assert.ok(
      marks.some(
        (mark) =>
          IsObject(mark) &&
          IsTextValue(mark.key) &&
          IsTextValue(mark.timing) &&
          !CANCELLATION_TIMINGS.some((timing) => timing === mark.timing),
      ),
      "no cancellation mark with a valid key and an unknown timing",
    );
    const foreign = fc.sample(ForeignCallerArb, PARAMETERS);
    assert.ok(
      foreign.some((value) => IsObject(ObjectOf(value)?.[CALLER])),
      "no other writer's metadata with a metadata object of its own",
    );
    assert.ok(foreign.some((value) => IsTextValue(value)));
    AssertMergeInputs(PARAMETERS);
    assert.ok(
      foreign.every((value) => {
        const object = ObjectOf(value);
        return (
          object !== undefined &&
          !Object.prototype.hasOwnProperty.call(object, OWN)
        );
      }),
    );
    const counts = fc
      .sample(TamperedOwnSubscriptionArb, PARAMETERS)
      .map((value) => OwnObjectOf(value)?.intervalCount);
    assert.ok(counts.some((count) => IsNumberValue(count) && count <= 0));
    assert.ok(
      counts.some((count) => IsNumberValue(count) && !Number.isInteger(count)),
    );
  });

  it("pins laterWritesFit: the documented budget at its edge, 600 caller bytes and the widest keys, ends at 1024 bytes after a period-end cancellation", () => {
    const { caller, canceled } = WidestSubscription();
    assert.deepEqual(
      [Bytes(caller), OwnBytes(canceled), Bytes(canceled)],
      [CALLER_BYTES, 398, 1023],
    );
  });
});
