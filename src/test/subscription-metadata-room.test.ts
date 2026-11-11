import assert from "node:assert/strict";
import {
  type CancellationTiming,
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  InvalidSubscriptionRequestError,
  ListSubscriptions,
  SubscriptionError,
} from "@antelopejs/interface-subscriptions";

import { CurrentHarness } from "./support/harness";
import {
  Key,
  PrimaryAccount,
  Reference,
  Rejected,
  RequireStandIn,
  TEST_TIMEOUT,
} from "./support/helpers";
import { Bytes, IsObject } from "./support/metadata-model";
import { type Payer, NewPayer } from "./support/payers";
import "./support/relay";

const LIMIT = 1024;
const OVER_BUDGET_BYTES = 700;
const LONGEST_CANCEL_KEY = "k".repeat(64);
const ROOM = /leaves (\d+) bytes for the subscription's metadata/;

function callerOf(size: number) {
  return { pad: "x".repeat(size - Bytes({ pad: "" })) };
}

function subscriptionPosts(customer: string): number {
  return PrimaryAccount().requests.filter(
    (request) =>
      request.method === "POST" &&
      request.path === `/v2/customers/${customer}/subscriptions`,
  ).length;
}

function subscriptionPatches(id: string): number {
  const child = id.split(":")[1] ?? "";
  return PrimaryAccount().requests.filter(
    (request) =>
      request.method === "PATCH" && request.path.endsWith(`/${child}`),
  ).length;
}

async function create(
  payer: Payer,
  metadata: Record<string, string>,
  reference = Reference(),
  key = Key(),
) {
  return CreateSubscription(
    {
      reference,
      customer: payer.customer,
      paymentMethod: payer.paymentMethod,
      amount: { value: 1900, currency: "EUR" },
      interval: "month",
      metadata,
    },
    key,
  );
}

async function roomFor(
  payer: Payer,
  reference: string,
  key: string,
): Promise<number> {
  const error = await Rejected(
    create(payer, callerOf(LIMIT), reference, key),
    InvalidSubscriptionRequestError,
  );
  const room = ROOM.exec(error.message)?.[1];
  assert.ok(room, error.message);
  return Number(room);
}

describe("[mollie] a subscription's metadata keeps room to cancel it", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("refuses at creation caller metadata that would leave no room to cancel, and sends nothing", async () => {
    const payer = await NewPayer();
    const error = await Rejected(
      create(payer, callerOf(OVER_BUDGET_BYTES)),
      InvalidSubscriptionRequestError,
    );
    assert.match(error.message, /1,024 bytes/);
    assert.match(error.message, ROOM);
    assert.equal(subscriptionPosts(payer.customer), 0);
    assert.deepEqual(await ListSubscriptions(payer.customer), []);
  });

  for (const timing of ["now", "period_end"] satisfies CancellationTiming[]) {
    it(`creates the most caller metadata it names, refuses one byte more, and cancels it ${timing} under a 64-byte key`, async () => {
      const payer = await NewPayer();
      const [reference, key] = [Reference(), Key()];
      const room = await roomFor(payer, reference, key);
      assert.ok(room >= 600, `only ${room} bytes left for the caller`);
      await Rejected(
        create(payer, callerOf(room + 1), reference, key),
        InvalidSubscriptionRequestError,
      );
      const created = await create(payer, callerOf(room), reference, key);
      const cancelled = await CancelSubscription(
        created.id,
        LONGEST_CANCEL_KEY,
        timing,
      );
      assert.deepEqual(
        [cancelled.status, cancelled.cancelAtPeriodEnd],
        timing === "now" ? ["canceled", false] : ["active", true],
      );
    });
  }

  it("rejects cancelling a subscription created past the room before it was kept, with a SubscriptionError naming it, and sends nothing", async () => {
    const payer = await NewPayer();
    const created = await create(payer, {});
    const child = created.id.split(":")[1] ?? "";
    const held = PrimaryAccount().subscriptions.get(child);
    assert.ok(held && IsObject(held.metadata));
    await CurrentHarness().client.execute({
      method: "PATCH",
      path: `/customers/${payer.customer}/subscriptions/${child}`,
      body: {
        metadata: {
          ...held.metadata,
          metadata: callerOf(OVER_BUDGET_BYTES),
        },
      },
    });
    const patches = subscriptionPatches(created.id);
    for (const timing of ["now", "period_end"] satisfies CancellationTiming[]) {
      const error = await Rejected(
        CancelSubscription(created.id, Key(), timing),
        SubscriptionError,
      );
      assert.match(error.message, new RegExp(created.id));
      assert.match(error.message, /1,024 bytes/);
    }
    assert.equal(subscriptionPatches(created.id), patches);
    const read = await GetSubscription(created.id);
    assert.deepEqual([read.status, read.cancelAtPeriodEnd], ["active", false]);
  });

  it("returns, on a replay of its creation, a subscription created past the room before it was kept", async () => {
    const payer = await NewPayer();
    const reference = Reference();
    const key = Key();
    const created = await create(payer, {}, reference, key);
    const child = created.id.split(":")[1] ?? "";
    const held = PrimaryAccount().subscriptions.get(child);
    assert.ok(held && IsObject(held.metadata));
    await CurrentHarness().client.execute({
      method: "PATCH",
      path: `/customers/${payer.customer}/subscriptions/${child}`,
      body: {
        metadata: { ...held.metadata, metadata: callerOf(OVER_BUDGET_BYTES) },
      },
    });
    const posts = subscriptionPosts(payer.customer);
    const replayed = await create(
      payer,
      callerOf(OVER_BUDGET_BYTES),
      reference,
      key,
    );
    assert.equal(replayed.id, created.id);
    assert.equal(subscriptionPosts(payer.customer), posts);
  });

  it("says a reference that alone overflows the room leaves none, not a negative count", async () => {
    const payer = await NewPayer();
    const error = await Rejected(
      create(payer, {}, "r".repeat(OVER_BUDGET_BYTES)),
      InvalidSubscriptionRequestError,
    );
    assert.doesNotMatch(error.message, /-\d+ bytes/);
    assert.match(error.message, /leaving none for the subscription's metadata/);
  });
});
