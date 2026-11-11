import assert from "node:assert/strict";
import {
  CapturePayment,
  CreatePayment,
  GetPayment,
  InvalidPaymentStateError,
  type Payment,
  PaymentError,
} from "@antelopejs/interface-payment";

import { CurrentHarness } from "./support/harness";
import { CreateCapture } from "./stand-in/payments-api";
import {
  Key,
  PrimaryAccount,
  Reference,
  Rejected,
  RequireStandIn,
  SettledPayment,
  StandIn,
  TEST_TIMEOUT,
} from "./support/helpers";

const EUR = (value: number) => ({ value, currency: "EUR" });
const TEN = EUR(1000);

async function authorizedHold(): Promise<string> {
  const created = await CreatePayment(
    {
      amount: EUR(2500),
      reference: Reference(),
      paymentMethod: CurrentHarness().chargeable,
      offSession: true,
      authorizeOnly: true,
    },
    Key(),
  );
  assert.equal((await SettledPayment(created.id)).status, "authorized");
  return created.id;
}

function captured(payment: Payment): [string, number] {
  return [payment.status, payment.amountCaptured.value];
}

function capturesPath(id: string): RegExp {
  return new RegExp(`^/v2/payments/${id}/captures$`);
}

function capturesSent(id: string): number {
  return PrimaryAccount().requests.filter(
    (request) =>
      request.method === "POST" && capturesPath(id).test(request.path),
  ).length;
}

function capturesHeld(id: string): number {
  return [...PrimaryAccount().captures.values()].filter(
    (capture) => capture.paymentId === id,
  ).length;
}

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
    const id = await authorizedHold();
    const payment = await CapturePayment(id, Key(), TEN);
    assert.deepEqual(captured(payment), ["succeeded", 1000]);
  });

  it("reports a capture still pending when the budget runs out as pending with its amount, and reads it back the same", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await authorizedHold();
    assert.deepEqual(captured(await CapturePayment(id, Key(), TEN)), [
      "pending",
      1000,
    ]);
    assert.deepEqual(captured(await GetPayment(id)), ["pending", 1000]);
    StandIn().settleCaptures(CurrentHarness().target.apiKey);
    assert.deepEqual(captured(await SettledPayment(id)), ["succeeded", 1000]);
  });

  it("refuses a second capture while the first is pending, without sending it to Mollie", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await authorizedHold();
    await CapturePayment(id, Key(), TEN);
    const error = await Rejected(
      CapturePayment(id, Key(), TEN),
      InvalidPaymentStateError,
    );
    assert.equal(error.status, "pending");
    assert.equal(capturesSent(id), 1);
  });

  it("returns the original capture for a replayed key while Mollie still has it pending", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await authorizedHold();
    const key = Key();
    await CapturePayment(id, key, TEN);
    const replay = await CapturePayment(id, key, TEN);
    assert.deepEqual(captured(replay), ["pending", 1000]);
    assert.equal(capturesHeld(id), 1);
  });

  it("reports a capture another caller made between its read and its request as a state error", async () => {
    StandIn().captureDelayMs = undefined;
    const id = await authorizedHold();
    StandIn().interceptions.push({
      method: "POST",
      path: capturesPath(id),
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
    assert.equal(capturesSent(id), 1);
  });

  it("keeps a 422 on a capture a PaymentError while the payment still has no capture", async () => {
    const id = await authorizedHold();
    StandIn().faults.push({
      method: "POST",
      path: capturesPath(id),
      status: 422,
    });
    const error = await Rejected(CapturePayment(id, Key(), TEN), PaymentError);
    assert.ok(
      !(error instanceof InvalidPaymentStateError),
      `must not be ${InvalidPaymentStateError.name}`,
    );
  });
});
