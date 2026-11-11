import assert from "node:assert/strict";

import { SUBSCRIPTION_INTERVALS } from "@antelopejs/interface-subscriptions";
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
  CallerArb,
  ChangesArb,
  Entries,
  ForeignObjectArb,
  Holds,
  IdArb,
  IsObject,
  IsNumberValue,
  IsTextValue,
  IsWritableOwnSubscription,
  KeyArb,
  MOLLIE_METADATA_BYTES,
  MOLLIE_SUBSCRIPTION_STATUSES,
  NonObjectArb,
  OWN,
  OwnObjectOf,
  OwnRecordArb,
  OwnSubscriptionArb,
  PaymentWith,
  RefundWith,
  StringEntries,
  SubscriptionWith,
  TamperedOwnSubscriptionArb,
  Wire,
} from "./support/metadata-model";

const DEFAULT_SEED = 20261111;
const RUNS = 300;
const SUITE_TIMEOUT_MS = 60_000;
const NOW = Date.parse("2026-11-11T12:00:00Z");
const STARTS = ["anchor", "charged", "trial"];
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
    const ownAfter = merged[OWN];
    assert.ok(IsObject(ownAfter), "the merged own record is an object");
    assert.deepEqual(
      Object.keys(merged).sort(),
      [...new Set([...Object.keys(before), OWN])].sort(),
    );
    for (const [key, value] of Object.entries(before)) {
      if (key !== OWN) assert.deepEqual(merged[key], value, `${key} changed`);
    }
    assert.deepEqual(Entries(ownAfter), Entries({ ...ownBefore, ...wanted }));
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
  NonObjectArb,
  ChangesArb,
  (foreign, changes) => {
    const merged = Wire(MergeOwn(foreign, changes));
    assert.ok(
      Holds(merged, foreign),
      `the merge dropped ${JSON.stringify(foreign)}: ${JSON.stringify(merged)}`,
    );
  },
);

function assertOwnTypes(own: OwnSubscription): void {
  assert.ok(IsTextValue(own.reference));
  assert.ok(SUBSCRIPTION_INTERVALS.includes(own.interval));
  assert.ok(IsNumberValue(own.intervalCount));
  assert.ok(STARTS.includes(own.start));
  for (const text of [own.createKey, own.firstPayment, own.refused]) {
    assert.ok(text === undefined || IsTextValue(text));
  }
  assert.ok(own.cancel === undefined || IsTextValue(own.cancel.key));
}

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
    if (own) assertOwnTypes(own);
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

const ownSubscriptionValues = fc.property(
  fc.oneof(AnyMetadataArb, TamperedOwnSubscriptionArb),
  (metadata: JsonValue) => {
    const own = ReadOwnSubscription(SubscriptionWith(metadata));
    if (!own) return;
    assert.ok(
      IsWritableOwnSubscription(own),
      `the module reads an own record it never writes: ${JSON.stringify(own)}`,
    );
  },
);

const CREATED_OWN = OwnSubscriptionArb.map(
  ({ reference, createKey, interval, intervalCount, start }) => ({
    reference,
    createKey,
    interval,
    intervalCount,
    start,
  }),
);

const laterWritesFit = fc.property(
  CREATED_OWN,
  fc.integer({ min: 0, max: MOLLIE_METADATA_BYTES }),
  fc.tuple(IdArb.payment, KeyArb, fc.integer({ min: 0, max: 4102444800000 })),
  (own, padding, [firstPayment, key, endsAt]) => {
    const created = Wire(WriteMetadata(own, { note: "x".repeat(padding) }));
    fc.pre(Bytes(created) <= MOLLIE_METADATA_BYTES);
    const charged = Wire(MergeOwn(created, { firstPayment }));
    const canceled = Wire(
      MergeOwn(charged, { cancel: { timing: "period_end", key, endsAt } }),
    );
    for (const [step, written] of [
      ["the first charge", charged],
      ["the cancellation", canceled],
    ] as const) {
      assert.ok(
        Bytes(written) <= MOLLIE_METADATA_BYTES,
        `Mollie accepted ${Bytes(created)} bytes at creation, ${step} writes ${Bytes(written)}`,
      );
    }
  },
);

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
    "a merge into a JSON object keeps every other key and every own field it does not change",
    mergeKeepsForeignKeys,
  );
  holds(
    "mergeKeepsCallerView",
    "a merge into metadata the module wrote leaves the caller's metadata as it reads",
    mergeKeepsCallerView,
  );
  finding(
    "mergeKeepsForeignCallerView",
    "a merge into another writer's JSON object leaves its string entries as the caller reads them",
    mergeKeepsForeignCallerView,
  );
  finding(
    "mergeKeepsForeignValue",
    "a merge into metadata that is not a JSON object keeps it",
    mergeKeepsForeignValue,
  );
  holds(
    "readsNeverThrow",
    "every metadata reader returns its documented types for any JSON, and a record without an own object is not the module's",
    readsNeverThrow,
  );
  finding(
    "ownSubscriptionValues",
    "an own subscription record the module accepts has values the module writes",
    ownSubscriptionValues,
  );
  finding(
    "laterWritesFit",
    "metadata Mollie accepted at creation still fits after the module records the first charge and a cancellation",
    laterWritesFit,
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
    const counts = fc
      .sample(TamperedOwnSubscriptionArb, PARAMETERS)
      .map((value) => OwnObjectOf(value)?.intervalCount);
    assert.ok(counts.some((count) => IsNumberValue(count) && count <= 0));
    assert.ok(
      counts.some((count) => IsNumberValue(count) && !Number.isInteger(count)),
    );
  });

  it("pins ownSubscriptionValues: interval counts 0 and -1 read as the module's, and 0 makes the period read throw", () => {
    const tampered = (intervalCount: number) =>
      SubscriptionWith(
        Wire({
          [OWN]: {
            ...READ_OWN,
            createKey: "create-1",
            interval: "day",
            intervalCount,
          },
          metadata: {},
        }),
      );
    assert.equal(ReadOwnSubscription(tampered(-1))?.intervalCount, -1);
    const mollie = tampered(0);
    const own = ReadOwnSubscription(mollie);
    assert.ok(own);
    assert.equal(own.intervalCount, 0);
    assert.throws(
      () => ToSubscription({ id: SUBSCRIPTION_ID, mollie, own }, NOW),
      { name: "RangeError", message: "Invalid time value" },
    );
  });

  it("pins laterWritesFit: 1024 bytes at creation grow to 1055 with the first charge and 1128 with a cancellation", () => {
    const own = {
      reference: "order-1",
      createKey: "create-1",
      interval: "month",
      intervalCount: 1,
      start: "charged",
    };
    const created = Wire(WriteMetadata(own, { note: "x".repeat(887) }));
    const charged = Wire(MergeOwn(created, { firstPayment: "tr_AAAAAAAAAA" }));
    const canceled = Wire(
      MergeOwn(charged, {
        cancel: {
          timing: "period_end",
          key: "cancel-1",
          endsAt: 4102444800000,
        },
      }),
    );
    assert.deepEqual(
      [Bytes(created), Bytes(charged), Bytes(canceled)],
      [1024, 1055, 1128],
    );
  });
});
