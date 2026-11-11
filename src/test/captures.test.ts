import assert from "node:assert/strict";
import {
  CapturePayment,
  GetPayment,
  InvalidPaymentStateError,
  PaymentError,
} from "@antelopejs/interface-payment";

import { CurrentHarness } from "./support/harness";
import { CreateCapture } from "./stand-in/payments-api";
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
  PaymentPath,
  TEN,
} from "./support/holds";

describe("[mollie] a capture Mollie applies after it answers", function () {
  this.timeout(TEST_TIMEOUT);
  let captureDelayMs: number | undefined;

  before(function () {
    RequireStandIn(this);
  });

  beforeEach(() => {
    captureDelayMs = StandIn().captureDelayMs;
  });

  afterEach(() => {
    StandIn().captureDelayMs = captureDelayMs;
  });

  it("returns the payment succeeded once Mollie applies the capture within the settle budget", async () => {
    const id = await AuthorizedHold();
    const payment = await CapturePayment(id, Key(), TEN);
    assert.deepEqual(Captured(payment), ["succeeded", 1000]);
  });

  it("reports a capture still pending when the budget runs out as pending with its amount, and reads it back the same", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await AuthorizedHold();
    assert.deepEqual(Captured(await CapturePayment(id, Key(), TEN)), [
      "pending",
      1000,
    ]);
    assert.deepEqual(Captured(await GetPayment(id)), ["pending", 1000]);
    StandIn().settleCaptures(CurrentHarness().target.apiKey);
    assert.deepEqual(Captured(await SettledPayment(id)), ["succeeded", 1000]);
  });

  it("refuses a second capture while the first is pending, without sending it to Mollie", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await AuthorizedHold();
    await CapturePayment(id, Key(), TEN);
    const error = await Rejected(
      CapturePayment(id, Key(), TEN),
      InvalidPaymentStateError,
    );
    assert.equal(error.status, "pending");
    assert.equal(CapturesSent(id), 1);
  });

  it("returns the original capture for a replayed key while Mollie still has it pending", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await AuthorizedHold();
    const key = Key();
    await CapturePayment(id, key, TEN);
    const replay = await CapturePayment(id, key, TEN);
    assert.deepEqual(Captured(replay), ["pending", 1000]);
    assert.equal(CapturesHeld(id), 1);
  });

  it("reports a capture another caller made between its read and its request as a state error", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await AuthorizedHold();
    StandIn().interceptions.push({
      method: "POST",
      path: PaymentPath(id, "/captures"),
      run: (account) => {
        CreateCapture({
          account,
          hooks: StandIn().paymentHooks,
          params: [id],
          query: new URLSearchParams(),
          body: {},
        });
      },
    });
    const error = await Rejected(
      CapturePayment(id, Key(), TEN),
      InvalidPaymentStateError,
    );
    assert.equal(error.status, "pending");
    assert.equal(CapturesSent(id), 1);
  });

  it("keeps a 422 on a capture a PaymentError while the payment still has no capture", async () => {
    const id = await AuthorizedHold();
    StandIn().faults.push({
      method: "POST",
      path: PaymentPath(id, "/captures"),
      status: 422,
    });
    const error = await Rejected(CapturePayment(id, Key(), TEN), PaymentError);
    assert.ok(
      !(error instanceof InvalidPaymentStateError),
      `must not be ${InvalidPaymentStateError.name}`,
    );
  });
});
