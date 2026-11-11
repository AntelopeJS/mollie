import assert from "node:assert/strict";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  InvalidSubscriptionStateError,
} from "@antelopejs/interface-subscriptions";

import { ParseSubscriptionId } from "../mollie/ids";
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

async function endedUnderFirstRelease(cancelKey: string) {
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
            [parsed.child]: {
              endedAt: ENDED_AT,
              endsAt: atPeriodEnd.currentPeriodEnd,
              key: cancelKey,
            },
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
});
