import assert from "node:assert/strict";
import { GetCustomer } from "@antelopejs/interface-payment";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
} from "@antelopejs/interface-subscriptions";

import { IsMollieCustomer } from "../mollie/resources";
import type { JsonValue } from "../mollie/types";
import { CurrentHarness } from "./support/harness";
import { Holds, IsObject } from "./support/metadata-model";
import { NewPayer } from "./support/payers";
import {
  Key,
  Reference,
  RequireStandIn,
  TEST_TIMEOUT,
} from "./support/helpers";
import "./support/relay";

const PERIOD = { value: 1900, currency: "EUR" };

async function storedMetadata(customerId: string): Promise<JsonValue> {
  const customer = await CurrentHarness().client.request(
    { method: "GET", path: `/customers/${customerId}` },
    IsMollieCustomer,
  );
  return customer.metadata ?? null;
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
      const payer = await NewPayer();
      await CurrentHarness().client.execute({
        method: "PATCH",
        path: `/customers/${payer.customer}`,
        body: { metadata },
      });
      assert.deepEqual((await GetCustomer(payer.customer)).metadata, reads);
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
