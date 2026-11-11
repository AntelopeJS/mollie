import assert from "node:assert/strict";
import {
  CancelPayment,
  CapturePayment,
  GetPayment,
  InvalidPaymentStateError,
  PaymentError,
} from "@antelopejs/interface-payment";

import { GetAccount } from "../accounts";
import { CurrentHarness } from "./support/harness";
import {
  Key,
  Rejected,
  RequireStandIn,
  SettledPayment,
  StandIn,
  TEST_TIMEOUT,
} from "./support/helpers";
import {
  AuthorizedHold,
  Captured,
  CapturesHeld,
  CapturesSent,
  OnceCaptured,
  PaymentPath,
  Sent,
  TEN,
} from "./support/holds";

const SETTLE_POLL_MS = 250;
const SLOW_READ_MS = 3_000;
const UNAVAILABLE = 503;

function budgetMs(): number {
  return GetAccount().settleTimeoutMs;
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const value = await work();
  return [value, Date.now() - start];
}

describe("[mollie] how a capture ends after Mollie accepts it", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  afterEach(() => {
    const standIn = StandIn();
    standIn.captureDelayMs = 100;
    standIn.captureOutcome = "succeeded";
    standIn.outage = undefined;
    standIn.delays.length = 0;
    standIn.faults.length = 0;
    standIn.interceptions.length = 0;
  });

  it("refuses to cancel a payment whose capture is in flight, without writing to Mollie", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await AuthorizedHold();
    await CapturePayment(id, Key(), TEN);
    const error = await Rejected(
      CancelPayment(id, Key()),
      InvalidPaymentStateError,
    );
    assert.equal(error.status, "pending");
    assert.equal(Sent("POST", PaymentPath(id, "/release-authorization")), 0);
    assert.equal(Sent("DELETE", PaymentPath(id)), 0);
    StandIn().settleCaptures(CurrentHarness().target.apiKey);
    assert.deepEqual(Captured(await SettledPayment(id)), ["succeeded", 1000]);
  });

  it("rejects a capture Mollie fails as soon as it fails, and leaves the hold authorized with nothing captured", async () => {
    StandIn().captureOutcome = "failed";
    const id = await AuthorizedHold();
    const [error, ms] = await timed(() =>
      Rejected(CapturePayment(id, Key(), TEN), PaymentError),
    );
    assert.ok(
      !(error instanceof InvalidPaymentStateError),
      `must not be ${InvalidPaymentStateError.name}`,
    );
    assert.ok(ms < budgetMs(), `took ${ms} ms of a ${budgetMs()} ms budget`);
    assert.deepEqual(Captured(await GetPayment(id)), ["authorized", 0]);
  });

  it("replays a failed capture's key as the same failure, without capturing again", async () => {
    StandIn().captureOutcome = "failed";
    const id = await AuthorizedHold();
    const key = Key();
    const first = await Rejected(CapturePayment(id, key, TEN), PaymentError);
    const replay = await Rejected(CapturePayment(id, key, TEN), PaymentError);
    assert.equal(replay.providerCode, first.providerCode);
    assert.equal(CapturesSent(id), 1);
  });

  it("leaves a capture under another key after a failed one to Mollie", async () => {
    StandIn().captureOutcome = "failed";
    const id = await AuthorizedHold();
    await Rejected(CapturePayment(id, Key(), TEN), PaymentError);
    const error = await Rejected(CapturePayment(id, Key(), TEN), PaymentError);
    assert.ok(
      !(error instanceof InvalidPaymentStateError),
      `must not be ${InvalidPaymentStateError.name}`,
    );
    assert.equal(CapturesSent(id), 2);
  });

  it("releases a hold whose capture failed", async () => {
    StandIn().captureOutcome = "failed";
    const id = await AuthorizedHold();
    await Rejected(CapturePayment(id, Key(), TEN), PaymentError);
    assert.equal((await CancelPayment(id, Key())).status, "canceled");
  });

  it("returns pending within one poll of the budget when Mollie is slow to answer a read", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await AuthorizedHold();
    OnceCaptured(id, () =>
      StandIn().delays.push({
        method: "GET",
        path: PaymentPath(id),
        ms: SLOW_READ_MS,
      }),
    );
    const [payment, ms] = await timed(() => CapturePayment(id, Key(), TEN));
    assert.deepEqual(Captured(payment), ["pending", 1000]);
    assert.ok(
      ms <= budgetMs() + SETTLE_POLL_MS,
      `took ${ms} ms of a ${budgetMs()} ms budget`,
    );
  });

  it("returns pending with the amount when a read fails after Mollie accepted the capture", async () => {
    const id = await AuthorizedHold();
    const key = Key();
    OnceCaptured(id, () => {
      StandIn().outage = UNAVAILABLE;
    });
    const payment = await CapturePayment(id, key, TEN);
    StandIn().outage = undefined;
    assert.deepEqual(Captured(payment), ["pending", 1000]);
    assert.equal(CapturesHeld(id), 1);
    assert.deepEqual(Captured(await CapturePayment(id, key, TEN)), [
      "succeeded",
      1000,
    ]);
  });
});
