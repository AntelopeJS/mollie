import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import {
  CapturePayment,
  CreatePayment,
  RefundPayment,
} from "@antelopejs/interface-payment";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  SubscriptionPaymentError,
  type SubscriptionRequest,
} from "@antelopejs/interface-subscriptions";
import fc from "fast-check";

import { ParsePaymentMethodId, SubscriptionId } from "../mollie/ids";
import { MergeOwn, WriteMetadata } from "../mollie/metadata";
import type { JsonValue } from "../mollie/types";
import customerCorpus from "./fixtures/metadata-corpus-customers.json";
import paymentCorpus from "./fixtures/metadata-corpus-payments.json";
import subscriptionCorpus from "./fixtures/metadata-corpus-subscriptions.json";
import { CurrentHarness } from "./support/harness";
import {
  Key,
  PrimaryAccount,
  Reference,
  Rejected,
  RequireStandIn,
  SettledPayment,
  TEST_TIMEOUT,
} from "./support/helpers";
import {
  type Fixture,
  FormatOf,
  IsCorpus,
  ReadFixture,
  SeedFixture,
  SeededRecords,
} from "./support/metadata-corpus";
import { WidestSubscription } from "./support/metadata-budget";
import {
  Bytes,
  CALLER_BYTES,
  CallerArb,
  ExpectedKeyHash,
  ForeignCallerArb,
  InstantArb,
  KeyArb,
  ObjectOf,
  OwnBytes,
  StringEntries,
  Wire,
} from "./support/metadata-model";
import { NewPayer, type Payer } from "./support/payers";
import "./support/relay";

function fixturesOf(
  corpus:
    | typeof paymentCorpus
    | typeof subscriptionCorpus
    | typeof customerCorpus,
): Fixture[] {
  if (!IsCorpus(corpus)) throw new TypeError("a corpus fixture is malformed");
  return corpus.fixtures;
}

const FIXTURES = [
  ...fixturesOf(paymentCorpus),
  ...fixturesOf(subscriptionCorpus),
  ...fixturesOf(customerCorpus),
];
const DEFAULT_SEED = 20261111;
const KEYED_RUNS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD = { value: 1900, currency: "EUR" };
const FAR_END = Date.UTC(2100, 0, 1);
let keyedRuns = 0;

const requestedSeed = Number.parseInt(process.env.FC_SEED ?? "", 10);
const PARAMETERS = {
  seed: Number.isInteger(requestedSeed) ? requestedSeed : DEFAULT_SEED,
  numRuns: KEYED_RUNS,
};

interface Written {
  step: string;
  resource: string;
  metadata: JsonValue | undefined;
}

async function mismatches(fixtures: Fixture[]): Promise<string[]> {
  const found: string[] = [];
  for (const fixture of fixtures) {
    const read = await ReadFixture(fixture);
    if (!isDeepStrictEqual(read, fixture.reads)) {
      found.push(`${fixture.name} (${fixture.since}): ${JSON.stringify(read)}`);
    }
  }
  return found;
}

function request(
  payer: Payer,
  overrides: Partial<SubscriptionRequest> = {},
): SubscriptionRequest {
  return {
    reference: Reference(),
    customer: payer.customer,
    paymentMethod: payer.paymentMethod,
    amount: PERIOD,
    interval: "month",
    metadata: { plan: "gold" },
    ...overrides,
  };
}

function subscriptionMetadata(id: string): JsonValue | undefined {
  const child = id.split(":")[1] ?? "";
  return structuredClone(PrimaryAccount().subscriptions.get(child)?.metadata);
}

function customerMetadata(id: string): JsonValue | undefined {
  return structuredClone(PrimaryAccount().customers.get(id)?.metadata);
}

function childrenOf(
  records: Iterable<{ paymentId: string; metadata?: JsonValue | null }>,
  paymentId: string,
): (JsonValue | undefined)[] {
  return [...records]
    .filter((record) => record.paymentId === paymentId)
    .map((record) => structuredClone(record.metadata ?? undefined));
}

async function writeSubscriptions(payer: Payer): Promise<Written[]> {
  const written: Written[] = [];
  const keep = (step: string, resource: string, metadata?: JsonValue) =>
    written.push({ step, resource, metadata });
  const anchored = await CreateSubscription(
    request(payer, { billingAnchor: Date.now() + 2 * DAY_MS }),
    Key(),
  );
  keep("anchored creation", "subscription", subscriptionMetadata(anchored.id));
  await CancelSubscription(anchored.id, Key(), "now");
  keep("cancel now", "subscription", subscriptionMetadata(anchored.id));
  const charged = await CreateSubscription(request(payer), Key());
  keep("charged creation", "subscription", subscriptionMetadata(charged.id));
  const charge = PrimaryAccount().payments.get(charged.latestPayment ?? "");
  keep("first-period charge", "payment", structuredClone(charge?.metadata));
  await CancelSubscription(charged.id, Key(), "period_end");
  keep(
    "cancel at period end",
    "subscription",
    subscriptionMetadata(charged.id),
  );
  await CancelSubscription(charged.id, Key(), "now");
  keep("early end", "customer", customerMetadata(payer.customer));
  return written;
}

async function writeRefused(): Promise<Written> {
  const payer = await NewPayer();
  const { child } = ParsePaymentMethodId(payer.paymentMethod) ?? { child: "" };
  PrimaryAccount().declinesAtCreation.add(child);
  await Rejected(
    CreateSubscription(request(payer), Key()),
    SubscriptionPaymentError,
  );
  const refused = [...PrimaryAccount().subscriptions.values()].find(
    (subscription) => subscription.customerId === payer.customer,
  );
  return {
    step: "refused creation",
    resource: "subscription",
    metadata: structuredClone(refused?.metadata),
  };
}

async function writePayments(): Promise<Written[]> {
  const offSession = async (authorizeOnly: boolean) => {
    const created = await CreatePayment(
      {
        amount: { value: 2500, currency: "EUR" },
        reference: Reference(),
        paymentMethod: CurrentHarness().chargeable,
        offSession: true,
        authorizeOnly,
        metadata: { order: "o-1" },
      },
      Key(),
    );
    await SettledPayment(created.id);
    return created.id;
  };
  const paid = await offSession(false);
  await RefundPayment(
    { payment: paid, amount: { value: 500, currency: "EUR" } },
    Key(),
  );
  await RefundPayment(
    {
      payment: paid,
      amount: { value: 500, currency: "EUR" },
      reason: "requested_by_customer",
    },
    Key(),
  );
  const authorized = await offSession(true);
  await CapturePayment(authorized, Key(), { value: 1000, currency: "EUR" });
  const account = PrimaryAccount();
  return [
    {
      step: "payment",
      resource: "payment",
      metadata: structuredClone(account.payments.get(paid)?.metadata),
    },
    ...childrenOf(account.refunds.values(), paid).map((metadata) => ({
      step: "refund",
      resource: "refund",
      metadata,
    })),
    ...childrenOf(account.captures.values(), authorized).map((metadata) => ({
      step: "capture",
      resource: "capture",
      metadata,
    })),
  ];
}

const keyedRoundTrip = fc.asyncProperty(
  KeyArb,
  CallerArb,
  InstantArb,
  async (key, caller, endedAt) => {
    keyedRuns += 1;
    const id = `Keyed${keyedRuns}`;
    const account = PrimaryAccount();
    const fixture: Fixture = {
      name: "keyed",
      since: "HEAD",
      until: null,
      writer: "generated",
      seed: {
        customer: {
          id: `cst_${id}`,
          metadata: Wire(
            MergeOwn(Wire(WriteMetadata({}, caller)), {
              endedEarly: { [`sub_${id}`]: [endedAt, ExpectedKeyHash(key)] },
            }),
          ),
        },
        subscription: {
          id: `sub_${id}`,
          status: "canceled",
          metadata: Wire(
            WriteMetadata(
              {
                reference: "keyed",
                createKey: key,
                interval: "month",
                intervalCount: 1,
                start: "anchor",
                cancel: {
                  timing: "period_end",
                  key: `${key} at period end`,
                  endsAt: FAR_END,
                },
              },
              caller,
            ),
          ),
        },
        payments: [
          { id: `tr_${id}`, status: "open", metadata: null },
          { id: `tr_${id}c`, metadata: null },
        ],
        refund: {
          id: `re_${id}`,
          paymentId: `tr_${id}`,
          metadata: Wire(WriteMetadata({ key }, caller)),
        },
        capture: {
          id: `cpt_${id}`,
          paymentId: `tr_${id}c`,
          metadata: Wire(WriteMetadata({ key })),
        },
      },
      reads: {},
    };
    SeedFixture(account, fixture);
    const metadata = Object.keys(caller).length > 0 ? caller : null;
    const read = await ReadFixture({
      ...fixture,
      reads: {
        refund: { metadata, replayKey: key },
        capture: { replayKey: key },
        customer: { metadata },
      },
    });
    assert.deepEqual(read.refund, { metadata, replayKey: key });
    assert.deepEqual(read.capture, { replayKey: key });
    assert.deepEqual(read.customer, { metadata });
    const subscription = SubscriptionId(`cst_${id}`, `sub_${id}`);
    const ended = await GetSubscription(subscription);
    assert.equal(ended.status, "canceled");
    assert.equal(ended.endedAt, endedAt);
    const replay = await CancelSubscription(subscription, key, "now");
    assert.equal(
      replay.endedAt,
      endedAt,
      "the key hash names the same request",
    );
  },
);

const foreignInterfaceView = fc.asyncProperty(
  ForeignCallerArb,
  async (foreign) => {
    keyedRuns += 1;
    const id = `Foreign${keyedRuns}`;
    const object = ObjectOf(foreign);
    assert.ok(object, "another writer's metadata is a JSON object");
    const caller = StringEntries(object);
    const metadata = Object.keys(caller).length > 0 ? caller : null;
    const fixture: Fixture = {
      name: "foreign",
      since: "HEAD",
      until: null,
      writer: "generated",
      seed: {
        customer: { id: `cst_${id}`, metadata: foreign },
        payments: [{ id: `tr_${id}`, metadata: foreign }],
      },
      reads: {
        customer: { metadata },
        payment: { id: `tr_${id}`, reference: "", metadata },
      },
    };
    SeedFixture(PrimaryAccount(), fixture);
    assert.deepEqual(await ReadFixture(fixture), fixture.reads);
  },
);

describe("[mollie] metadata written by earlier versions", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
    for (const fixture of FIXTURES) SeedFixture(PrimaryAccount(), fixture);
  });

  it("holds corpusReads: every stored shape since ef5dfaf reads as the version that wrote it read it", async () => {
    assert.ok(FIXTURES.length > 0);
    assert.deepEqual(await mismatches(FIXTURES), []);
  });

  it("holds legacyEarlyEnd: the first release's early end ends its subscription early", async () => {
    const [legacy] = FIXTURES.filter(
      (fixture) => fixture.name === "early-end-first-release",
    );
    assert.ok(legacy);
    const read = await ReadFixture(legacy);
    assert.equal(read.subscription?.status, "canceled");
    assert.equal(read.subscription?.cancelAtPeriodEnd, false);
    assert.equal(read.subscription?.endedAt, 1779265800000);
  });

  it("holds corpusCoversWriters: every record the writers write today has the shape of a current fixture", async () => {
    const payer = await NewPayer({ crm: "c-1" });
    const written: Written[] = [
      {
        step: "customer creation",
        resource: "customer",
        metadata: customerMetadata(payer.customer),
      },
      ...(await writeSubscriptions(payer)),
      await writeRefused(),
      ...(await writePayments()),
    ];
    const known = new Set(
      FIXTURES.filter((fixture) => fixture.until === null).flatMap((fixture) =>
        SeededRecords(fixture).map(
          ({ resource, metadata }) => `${resource} ${FormatOf(metadata)}`,
        ),
      ),
    );
    const unknown = written
      .map(({ step, resource, metadata }) => ({
        step,
        format: `${resource} ${FormatOf(metadata ?? null)}`,
      }))
      .filter(({ format }) => !known.has(format));
    assert.ok(written.some(({ step }) => step === "capture"));
    assert.equal(written.filter(({ step }) => step === "refund").length, 2);
    assert.deepEqual(unknown, []);
  });

  it("holds keyedRoundTrip: a refund, capture and early end stored under any key replay and read back under it", async () => {
    const details = await fc.check(keyedRoundTrip, PARAMETERS);
    assert.ok(!details.failed, fc.defaultReportMessage(details));
  });

  it("holds foreignInterfaceView: GetPayment and GetCustomer read another writer's metadata, with no `antelope` key, as its string entries", async () => {
    const details = await fc.check(foreignInterfaceView, PARAMETERS);
    assert.ok(!details.failed, fc.defaultReportMessage(details));
  });
});

describe("[mollie] metadata pins", function () {
  this.timeout(TEST_TIMEOUT);

  it("pins laterWritesFit: the documented budget at its edge, 600 caller bytes and the widest keys, ends at 1024 bytes after a period-end cancellation", () => {
    const { caller, canceled } = WidestSubscription();
    assert.deepEqual(
      [Bytes(caller), OwnBytes(canceled), Bytes(canceled)],
      [CALLER_BYTES, 398, 1023],
    );
  });
});
