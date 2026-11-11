import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  InvalidSubscriptionStateError,
  ListSubscriptions,
  SUBSCRIPTION_INTERVALS,
  type Subscription,
  SubscriptionError,
  SubscriptionNotFoundError,
  type SubscriptionRequest,
} from "@antelopejs/interface-subscriptions";

import {
  AddPeriods,
  ParseDate,
  PeriodStartBefore,
} from "../implementations/subscriptions/calendar";
import { SubscriptionPath } from "../implementations/subscriptions/records";
import { ParseSubscriptionId } from "../mollie/ids";
import { IsJsonObject } from "../mollie/metadata";
import { IsMollieSubscription } from "../mollie/resources";
import type { JsonObject } from "../mollie/types";
import { RenewSubscription } from "./stand-in/subscriptions-api";
import { UNDOCUMENTED_MOLLIE_INTERVALS } from "./support/calendar-model";
import { CurrentHarness } from "./support/harness";
import {
  Key,
  PrimaryAccount,
  Reference,
  Rejected,
  RequireStandIn,
  SettledPayment,
  StandIn,
  TEST_TIMEOUT,
  Within,
} from "./support/helpers";
import { NewPayer, type Payer } from "./support/payers";

const BLOCKED_LIMIT_MS = 10_000;
const BEAT_MS = 100;
const HOUR_MS = 60 * 60 * 1000;
const LAST_DAY_OF_9999 = Date.UTC(9999, 11, 31);
const DROPPED_ENDS = [
  { name: "past any date", endsAt: 1e300 },
  { name: "the latest a Date holds", endsAt: 8.64e15 },
  { name: "just before the latest a Date holds", endsAt: 8.64e15 - 1 },
  { name: "past the last day of 9999", endsAt: LAST_DAY_OF_9999 + 1 },
];

const WATCHDOG = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const beats = new Int32Array(workerData.beats);
let last = Atomics.load(beats, 0);
for (;;) {
  Atomics.wait(beats, 0, last, workerData.limitMs);
  const now = Atomics.load(beats, 0);
  if (now === last) {
    writeSync(2, "\\n" + workerData.message + "\\n");
    process.kill(process.pid, "SIGKILL");
  }
  last = now;
}
`;

/**
 * Kills the test process when its event loop stays blocked past `limitMs`, so
 * a read that loops forever fails the run instead of hanging it. Mocha's own
 * timeout runs on the blocked loop and never fires.
 */
function watchEventLoop(limitMs: number): () => Promise<void> {
  const beats = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  const worker = new Worker(WATCHDOG, {
    eval: true,
    workerData: {
      beats: beats.buffer,
      limitMs,
      message: `[mollie] a subscription read blocked the event loop for ${limitMs} ms`,
    },
  });
  worker.unref();
  const beat = setInterval(() => {
    Atomics.add(beats, 0, 1);
    Atomics.notify(beats, 0);
  }, BEAT_MS);
  beat.unref();
  return async () => {
    clearInterval(beat);
    await worker.terminate();
  };
}

function pathOf(id: string): string {
  const parsed = ParseSubscriptionId(id);
  assert.ok(parsed);
  return SubscriptionPath(parsed.parent, parsed.child);
}

async function tamper(
  id: string,
  change: (own: JsonObject) => JsonObject,
): Promise<void> {
  const path = pathOf(id);
  const { client } = CurrentHarness();
  const mollie = await client.request(
    { method: "GET", path },
    IsMollieSubscription,
  );
  const stored = mollie.metadata;
  assert.ok(IsJsonObject(stored) && IsJsonObject(stored.antelope));
  await client.execute({
    method: "PATCH",
    path,
    body: { metadata: { ...stored, antelope: change(stored.antelope) } },
  });
}

async function listed(
  payer: Payer,
  id: string,
): Promise<Subscription | undefined> {
  const all = await ListSubscriptions(payer.customer);
  return all.find((subscription) => subscription.id === id);
}

function requestFor(payer: Payer): SubscriptionRequest {
  return {
    reference: Reference(),
    customer: payer.customer,
    paymentMethod: payer.paymentMethod,
    amount: { value: 1900, currency: "EUR" },
    interval: "week",
    intervalCount: 2,
  };
}

async function create(payer: Payer): Promise<Subscription> {
  return CreateSubscription(requestFor(payer), Key());
}

function heldByMollie(id: string) {
  const mollie = PrimaryAccount().subscriptions.get(
    ParseSubscriptionId(id)?.child ?? "",
  );
  assert.ok(mollie);
  return mollie;
}

function heldFor(payer: Payer): number {
  return [...PrimaryAccount().subscriptions.values()].filter(
    (mollie) => mollie.customerId === payer.customer,
  ).length;
}

async function cancelAtMollieWithEnd(
  id: string,
  endsAt: number,
): Promise<void> {
  await tamper(id, (stored) => ({
    ...stored,
    cancel: { timing: "period_end", key: Key(), endsAt },
  }));
  await CurrentHarness().client.execute({ method: "DELETE", path: pathOf(id) });
}

async function inSecondPeriod(created: Subscription): Promise<number> {
  const renewal = RenewSubscription(
    PrimaryAccount(),
    StandIn().paymentHooks,
    heldByMollie(created.id),
  );
  await SettledPayment(renewal.id);
  return created.currentPeriodEnd - Date.now() + HOUR_MS;
}

const TAMPERED: { name: string; own: JsonObject }[] = [
  { name: "an interval count of 0", own: { intervalCount: 0 } },
  { name: "an interval count of 1.5", own: { intervalCount: 1.5 } },
  { name: "an interval count stored as text", own: { intervalCount: "2" } },
  {
    name: "an interval count past Mollie's longest",
    own: { intervalCount: 53 },
  },
  {
    name: "an interval the interface does not know",
    own: { interval: "fortnight" },
  },
  { name: "an interval count of -1", own: { intervalCount: -1 } },
];

describe("[mollie] calendar periods with a count no schedule has", () => {
  const anchor = ParseDate("2026-01-31");
  const end = Date.parse("2026-06-15T00:00:00Z");
  let stopWatching: () => Promise<void> = async () => undefined;

  before(() => {
    stopWatching = watchEventLoop(BLOCKED_LIMIT_MS);
  });

  after(async () => {
    await stopWatching();
  });

  for (const count of [0, -1, 1.5]) {
    it(`refuses an interval count of ${count} with a RangeError instead of a date or a loop`, () => {
      for (const interval of SUBSCRIPTION_INTERVALS) {
        assert.throws(
          () => AddPeriods(anchor, { interval, count }, 1),
          RangeError,
        );
        assert.throws(
          () => PeriodStartBefore(anchor, { interval, count }, end),
          RangeError,
        );
      }
    });
  }
});

describe("[mollie] subscriptions whose own record another writer changed", function () {
  this.timeout(TEST_TIMEOUT);

  let payer: Payer;
  let stopWatching: () => Promise<void> = async () => undefined;

  before(async function () {
    RequireStandIn(this);
    stopWatching = watchEventLoop(BLOCKED_LIMIT_MS);
    payer = await NewPayer();
  });

  after(async () => {
    await stopWatching();
  });

  for (const { name, own } of TAMPERED) {
    it(`reads, lists and cancels a subscription in its second period whose own record has ${name}, at the interval Mollie bills`, async () => {
      const created = await create(payer);
      const later = await inSecondPeriod(created);
      const untouched = await Within(later, () => GetSubscription(created.id));
      assert.equal(untouched.currentPeriodStart, created.currentPeriodEnd);
      await tamper(created.id, (stored) => ({ ...stored, ...own }));

      await Within(later, async () => {
        assert.deepEqual(await GetSubscription(created.id), untouched);
        assert.deepEqual(await listed(payer, created.id), untouched);
        const canceled = await CancelSubscription(created.id, Key(), "now");
        assert.equal(canceled.status, "canceled");
      });
    });
  }

  for (const { name, endsAt } of DROPPED_ENDS) {
    it(`reads and lists a subscription Mollie cancelled whose stored period end is ${name}, as ended`, async () => {
      const created = await create(payer);
      await cancelAtMollieWithEnd(created.id, endsAt);

      const read = await GetSubscription(created.id);
      assert.equal(read.status, "canceled");
      assert.equal((await listed(payer, created.id))?.status, "canceled");
      await Rejected(
        CancelSubscription(created.id, Key(), "now"),
        InvalidSubscriptionStateError,
      );
    });
  }

  it("keeps a stored period end on the last day of 9999", async () => {
    const created = await create(payer);
    await cancelAtMollieWithEnd(created.id, LAST_DAY_OF_9999);

    const read = await GetSubscription(created.id);
    assert.equal(read.cancelAtPeriodEnd, true);
    assert.equal(read.currentPeriodEnd, LAST_DAY_OF_9999);
  });
});

describe("[mollie] a subscription whose stored period and Mollie's interval are both unreadable", function () {
  this.timeout(TEST_TIMEOUT);

  let payer: Payer;
  let other: Subscription;
  let stopWatching: () => Promise<void> = async () => undefined;

  before(async function () {
    RequireStandIn(this);
    stopWatching = watchEventLoop(BLOCKED_LIMIT_MS);
    payer = await NewPayer();
    other = await create(payer);
  });

  after(async () => {
    await stopWatching();
  });

  for (const interval of UNDOCUMENTED_MOLLIE_INTERVALS) {
    it(`refuses to read, cancel or replay it with a SubscriptionError naming it when Mollie bills it every "${interval}", and still lists and creates the customer's others`, async () => {
      const request = requestFor(payer);
      const key = Key();
      const broken = await CreateSubscription(request, key);
      await tamper(broken.id, (stored) => ({ ...stored, intervalCount: 0 }));
      heldByMollie(broken.id).interval = interval;
      const held = heldFor(payer);

      for (const call of [
        () => GetSubscription(broken.id),
        () => CancelSubscription(broken.id, Key(), "now"),
        () => Within(2 * HOUR_MS, () => CreateSubscription(request, key)),
      ]) {
        const error = await Rejected(call(), SubscriptionError);
        assert.ok(!(error instanceof SubscriptionNotFoundError), error.message);
        assert.ok(error.message.includes(broken.id), error.message);
      }
      assert.equal(heldByMollie(broken.id).status, "active");
      assert.equal(heldFor(payer), held);

      const another = await create(payer);
      const ids = (await ListSubscriptions(payer.customer)).map(
        (subscription) => subscription.id,
      );
      assert.ok(ids.includes(other.id) && ids.includes(another.id));
      assert.ok(!ids.includes(broken.id));
    });
  }
});
