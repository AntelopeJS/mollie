import assert from "node:assert/strict";
import {
  GetPayment,
  InvalidPaymentStateError,
  RefundPayment,
  type Refund,
  VerifyWebhook,
} from "@antelopejs/interface-payment";

import {
  Key,
  MollieReports,
  PaidPayment,
  PrimaryAccount,
  RequireStandIn,
  StandIn,
  SetRefundStatus,
  TEST_TIMEOUT,
} from "./support/helpers";

const EUR = (value: number) => ({ value, currency: "EUR" });
const MOLLIE_PAGE = 250;
const REFUND_LIST = /^\/v2\/payments\/[^/]+\/refunds$/;

function refundRequests(): number {
  return PrimaryAccount().requests.filter((request) =>
    /\/payments\/[^/]+\/refunds/.test(request.path),
  ).length;
}

async function refund(id: string, value: number): Promise<Refund> {
  return RefundPayment({ payment: id, amount: EUR(value) }, Key());
}

describe("[mollie] the refunded amount of a payment", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("is the sum of the refunds Mollie has refunded", async () => {
    const id = await PaidPayment();
    await refund(id, 500);
    await refund(id, 700);
    const payment = await GetPayment(id);
    assert.deepEqual(payment.amountRefunded, EUR(1200));
  });

  it("is the sum of the refunds Mollie has refunded while Mollie's own amountRefunded still trails them", async () => {
    const id = await PaidPayment();
    await refund(id, 500);
    await refund(id, 700);
    MollieReports(id, "amountRefunded", "5.00");
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(1200));
    MollieReports(id, "amountRefunded", "0.00");
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(1200));
  });

  it("still reads a payment whose refunds Mollie fails to list, with Mollie's own refunded amount", async () => {
    const id = await PaidPayment();
    await refund(id, 500);
    MollieReports(id, "amountRefunded", "5.00");
    StandIn().faults.push({ method: "GET", path: REFUND_LIST, status: 503 });
    const read = await GetPayment(id);
    assert.equal(read.status, "succeeded");
    assert.deepEqual(read.amountRefunded, EUR(500));
    StandIn().faults.push({ method: "GET", path: REFUND_LIST, status: 503 });
    const event = await VerifyWebhook({
      body: Buffer.from(`id=${id}`),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.deepEqual(event?.payment?.amountRefunded, EUR(500));
  });

  it("reads a settled refund on a payment whose amountRemaining is above its amount, and asks for none before there is one", async () => {
    const id = await PaidPayment();
    MollieReports(id, "amountRemaining", "56.00");
    const before = refundRequests();
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(0));
    assert.equal(refundRequests(), before);
    await refund(id, 100);
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(100));
  });

  it("reads a settled refund on a payment that reports no amountRemaining, and asks for none before there is one", async () => {
    const id = await PaidPayment();
    MollieReports(id, "amountRemaining", undefined);
    const before = refundRequests();
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(0));
    assert.equal(refundRequests(), before);
    await refund(id, 500);
    MollieReports(id, "amountRemaining", undefined);
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(500));
  });

  it("reads a pending refund on a payment whose amountRemaining is above its amount as refunded zero", async () => {
    const id = await PaidPayment();
    const waiting = await refund(id, 100);
    SetRefundStatus(waiting.id, "pending");
    MollieReports(id, "amountRemaining", "56.00");
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(0));
  });

  it("counts a refund only once Mollie reports it refunded", async () => {
    const id = await PaidPayment();
    await refund(id, 500);
    const waiting = await refund(id, 300);
    const queued = await refund(id, 200);
    const processing = await refund(id, 100);
    const canceled = await refund(id, 50);
    const failed = await refund(id, 25);
    SetRefundStatus(waiting.id, "pending");
    SetRefundStatus(queued.id, "queued");
    SetRefundStatus(processing.id, "processing");
    SetRefundStatus(canceled.id, "canceled");
    SetRefundStatus(failed.id, "failed");
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(500));
    SetRefundStatus(waiting.id, "refunded");
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(800));
  });

  it("stops counting a refund that was refunded and then ends failed", async () => {
    const id = await PaidPayment();
    const first = await refund(id, 500);
    await refund(id, 300);
    SetRefundStatus(first.id, "failed");
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(300));
  });

  it("reads a payment whose only refund is still pending as refunded zero, with its amount already out of what is left", async () => {
    const id = await PaidPayment();
    const waiting = await refund(id, 500);
    SetRefundStatus(waiting.id, "pending");
    const payment = await GetPayment(id);
    assert.deepEqual(payment.amountRefunded, EUR(0));
    await assert.rejects(() => refund(id, 2001), InvalidPaymentStateError);
  });

  it("adds up the refunds of every page Mollie lists", async () => {
    const id = await PaidPayment();
    for (let index = 0; index <= MOLLIE_PAGE; index += 1) {
      await refund(id, 1);
    }
    assert.deepEqual(
      (await GetPayment(id)).amountRefunded,
      EUR(MOLLIE_PAGE + 1),
    );
  });

  it("asks Mollie for refunds only of a payment that has some", async () => {
    const id = await PaidPayment();
    const before = refundRequests();
    assert.deepEqual((await GetPayment(id)).amountRefunded, EUR(0));
    assert.equal(refundRequests(), before);
    await refund(id, 500);
    const afterRefund = refundRequests();
    await GetPayment(id);
    assert.equal(refundRequests(), afterRefund + 1);
  });
});
