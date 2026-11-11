import assert from "node:assert/strict";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  InvalidSubscriptionStateError,
} from "@antelopejs/interface-subscriptions";

import { ParseSubscriptionId } from "../mollie/ids";
import type { JsonObject } from "../mollie/types";
import { CurrentHarness } from "./support/harness";
import {
  Key,
  Reference,
  Rejected,
  RequireStandIn,
  TEST_TIMEOUT,
} from "./support/helpers";
import { NewPayer } from "./support/payers";
import "./support/relay";

const PERIOD = { value: 1900, currency: "EUR" };
const ENDED_AT = Date.UTC(2026, 4, 20, 8, 30);

type StoredEarlyEnd = (endsAt: number, key: string) => JsonObject;

const FIRST_RELEASE: StoredEarlyEnd = (endsAt, key) => ({
  endedAt: ENDED_AT,
  endsAt,
  key,
});

async function endedUnderFirstRelease(
  cancelKey: string,
  stored: StoredEarlyEnd = FIRST_RELEASE,
) {
  const payer = await NewPayer();
  const created = await CreateSubscription(
    {
      reference: Reference(),
      customer: payer.customer,
      paymentMethod: payer.paymentMethod,
      amount: PERIOD,
      interval: "month",
    },
    Key(),
  );
  const atPeriodEnd = await CancelSubscription(created.id, Key(), "period_end");
  assert.equal(atPeriodEnd.cancelAtPeriodEnd, true);
  const parsed = ParseSubscriptionId(created.id);
  assert.ok(parsed);
  await CurrentHarness().client.execute({
    method: "PATCH",
    path: `/customers/${payer.customer}`,
    body: {
      metadata: {
        antelope: {
          endedEarly: {
            [parsed.child]: stored(atPeriodEnd.currentPeriodEnd, cancelKey),
          },
        },
      },
    },
  });
  return created.id;
}

describe("[mollie] an early end stored by the first release", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("reads as the subscription's early end", async () => {
    const id = await endedUnderFirstRelease(Key());
    const read = await GetSubscription(id);
    assert.equal(read.status, "canceled");
    assert.equal(read.cancelAtPeriodEnd, false);
    assert.equal(read.endedAt, ENDED_AT);
  });

  it("replays the cancellation that was stored under its key and refuses another", async () => {
    const key = Key();
    const id = await endedUnderFirstRelease(key);
    const replay = await CancelSubscription(id, key, "now");
    assert.equal(replay.status, "canceled");
    assert.equal(replay.endedAt, ENDED_AT);
    await Rejected(
      CancelSubscription(id, Key(), "now"),
      InvalidSubscriptionStateError,
    );
  });

  const NOT_FIRST_RELEASE: [string, StoredEarlyEnd][] = [
    [
      "an endsAt that is not a number",
      (_endsAt, key) => ({ endedAt: ENDED_AT, endsAt: "soon", key }),
    ],
    ["no endsAt", (_endsAt, key) => ({ endedAt: ENDED_AT, key })],
    [
      "a field the first release never wrote",
      (endsAt, key) => ({ endedAt: ENDED_AT, endsAt, key, extra: 1 }),
    ],
  ];

  for (const [name, stored] of NOT_FIRST_RELEASE) {
    it(`does not read a stored value with ${name} as an early end`, async () => {
      const read = await GetSubscription(
        await endedUnderFirstRelease(Key(), stored),
      );
      assert.equal(read.status, "active");
      assert.equal(read.cancelAtPeriodEnd, true);
    });
  }
});
