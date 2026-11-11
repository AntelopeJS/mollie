import assert from "node:assert/strict";
import { GetCustomer } from "@antelopejs/interface-payment";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  SubscriptionError,
} from "@antelopejs/interface-subscriptions";

import { IsMollieCustomer } from "../mollie/resources";
import type { JsonValue } from "../mollie/types";
import { CurrentHarness } from "./support/harness";
import { Holds, IsObject } from "./support/metadata-model";
import { NewPayer } from "./support/payers";
import {
  Key,
  PrimaryAccount,
  Reference,
  Rejected,
  RequireStandIn,
  TEST_TIMEOUT,
} from "./support/helpers";
import "./support/relay";

const PERIOD = { value: 1900, currency: "EUR" };
const LIMIT = 1024;

async function storedMetadata(customerId: string): Promise<JsonValue> {
  const customer = await CurrentHarness().client.request(
    { method: "GET", path: `/customers/${customerId}` },
    IsMollieCustomer,
  );
  return customer.metadata ?? null;
}

function bytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertKept(stored: JsonValue, written: JsonValue): void {
  if (!IsObject(written)) {
    assert.ok(Holds(stored, written), `${JSON.stringify(stored)} lost it`);
    return;
  }
  assert.ok(IsObject(stored));
  for (const [key, value] of Object.entries(written)) {
    if (key !== "antelope") {
      assert.deepEqual(stored[key], value, `${key} changed`);
    }
  }
}

async function customerHolding(metadata: JsonValue) {
  const payer = await NewPayer();
  await CurrentHarness().client.execute({
    method: "PATCH",
    path: `/customers/${payer.customer}`,
    body: { metadata },
  });
  return payer;
}

async function endedAtPeriodEnd(payer: Awaited<ReturnType<typeof NewPayer>>) {
  const subscription = await CreateSubscription(
    {
      reference: Reference(),
      customer: payer.customer,
      paymentMethod: payer.paymentMethod,
      amount: PERIOD,
      interval: "month",
    },
    Key(),
  );
  await CancelSubscription(subscription.id, Key(), "period_end");
  return subscription;
}

function customerPatches(customerId: string): number {
  return PrimaryAccount().requests.filter(
    (request) =>
      request.method === "PATCH" &&
      request.path === `/v2/customers/${customerId}`,
  ).length;
}

interface Case {
  name: string;
  metadata: JsonValue;
  reads: Record<string, string> | undefined;
}

const CASES: Case[] = [
  { name: "a string", metadata: "crm-9", reads: undefined },
  { name: "a number", metadata: 42, reads: undefined },
  { name: "a list", metadata: ["crm-9", "vip"], reads: undefined },
  {
    name: "a string holding a JSON object",
    metadata: '{"a":"b"}',
    reads: { a: "b" },
  },
  {
    name: "a string holding a JSON object with a metadata object of its own",
    metadata: '{"crm":"c-9","metadata":{"plan":"gold"}}',
    reads: { crm: "c-9" },
  },
  {
    name: "an object with a metadata object of its own",
    metadata: { crm: "c-9", metadata: { plan: "gold" } },
    reads: { crm: "c-9" },
  },
  {
    name: "an object already carrying the module's key",
    metadata: { crm: "c-9", antelope: {}, metadata: { plan: "gold" } },
    reads: { plan: "gold" },
  },
];

describe("[mollie] an early end on a customer whose metadata another writer set", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  for (const { name, metadata, reads } of CASES) {
    it(`keeps ${name} and what GetCustomer reads of it, and the early end reads back`, async () => {
      const payer = await customerHolding(metadata);
      assert.deepEqual((await GetCustomer(payer.customer)).metadata, reads);
      const subscription = await endedAtPeriodEnd(payer);
      await CancelSubscription(subscription.id, Key(), "now");

      assert.deepEqual((await GetCustomer(payer.customer)).metadata, reads);
      assertKept(await storedMetadata(payer.customer), metadata);
      const read = await GetSubscription(subscription.id);
      assert.equal(read.status, "canceled");
      assert.equal(read.cancelAtPeriodEnd, false);
      assert.ok((read.endedAt ?? Infinity) < subscription.currentPeriodEnd);
    });
  }
});

describe("[mollie] an early end whose record would not fit the customer's metadata", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  async function overheadOf(
    holderOf: (pad: string) => JsonValue,
  ): Promise<number> {
    const payer = await customerHolding(holderOf("x"));
    const subscription = await endedAtPeriodEnd(payer);
    await CancelSubscription(subscription.id, Key(), "now");
    return bytes(await storedMetadata(payer.customer)) - bytes(holderOf("x"));
  }

  const HOLDERS: [string, (pad: string) => JsonValue][] = [
    ["a string", (pad) => pad],
    [
      "an object with a metadata object of its own",
      (pad) => ({ crm: pad, metadata: { plan: "gold" } }),
    ],
  ];

  for (const [name, holderOf] of HOLDERS) {
    it(`records the early end on ${name} when the customer's metadata then holds exactly Mollie's limit`, async () => {
      const overhead = await overheadOf(holderOf);
      const padding = LIMIT - overhead - bytes(holderOf(""));
      const metadata = holderOf("a".repeat(padding));
      const payer = await customerHolding(metadata);
      const subscription = await endedAtPeriodEnd(payer);
      await CancelSubscription(subscription.id, Key(), "now");
      assert.equal(bytes(await storedMetadata(payer.customer)), LIMIT);
    });

    it(`refuses the early end on ${name} one byte past Mollie's limit, with no write and the metadata untouched`, async () => {
      const overhead = await overheadOf(holderOf);
      const padding = LIMIT - overhead - bytes(holderOf("")) + 1;
      const metadata = holderOf("a".repeat(padding));
      const payer = await customerHolding(metadata);
      assert.ok(bytes(metadata) <= LIMIT);
      const subscription = await endedAtPeriodEnd(payer);
      const patches = customerPatches(payer.customer);
      const error = await Rejected(
        CancelSubscription(subscription.id, Key(), "now"),
        SubscriptionError,
      );
      assert.match(error.message, /no room to record the early end/);
      assert.equal(customerPatches(payer.customer), patches);
      assert.deepEqual(await storedMetadata(payer.customer), metadata);
    });
  }

  it("counts the bytes of the metadata, not its characters", async () => {
    const overhead = await overheadOf((pad) => pad);
    const characters = (LIMIT - overhead - bytes("")) / 2 + 1;
    const metadata = "é".repeat(Math.floor(characters));
    assert.ok(metadata.length < LIMIT - overhead);
    const payer = await customerHolding(metadata);
    const subscription = await endedAtPeriodEnd(payer);
    const patches = customerPatches(payer.customer);
    const error = await Rejected(
      CancelSubscription(subscription.id, Key(), "now"),
      SubscriptionError,
    );
    assert.match(error.message, /no room to record the early end/);
    assert.equal(customerPatches(payer.customer), patches);
  });
});

describe("[mollie] the stand-in's limit on metadata", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("accepts metadata of 1,024 bytes and refuses one byte more, counting bytes", async () => {
    const payer = await NewPayer();
    const patch = (metadata: JsonValue) =>
      CurrentHarness().client.execute({
        method: "PATCH",
        path: `/customers/${payer.customer}`,
        body: { metadata },
      });
    await patch("a".repeat(LIMIT - bytes("")));
    const refused = { status: 422, field: "metadata" };
    await assert.rejects(patch("a".repeat(LIMIT - bytes("") + 1)), refused);
    await assert.rejects(patch("é".repeat(LIMIT / 2)), refused);
  });
});
