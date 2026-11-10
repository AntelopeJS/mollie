import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  CapturePayment,
  type Payment,
  PaymentNotFoundError,
  type Refund,
  RefundPayment,
} from "@antelopejs/interface-payment";

import { InTurnOrder } from "../implementations/payment/errors";
import {
  Key,
  PrimaryAccount,
  Rejected,
  RequireStandIn,
  TEST_TIMEOUT,
} from "./support/helpers";

const MALFORMED = "tr_not_a_payment";
const ABSENT = "tr_absent00000000";
const IN_FLIGHT_MS = 200;

const ACTIONS: [string, (id: string) => Promise<Payment | Refund>][] = [
  ["capture", (id) => CapturePayment(id, Key())],
  ["refund", (id) => RefundPayment({ payment: id }, Key())],
];

function requestsNaming(fragment: string): number {
  return PrimaryAccount().requests.filter((request) =>
    request.path.includes(fragment),
  ).length;
}

describe("[mollie] captures and refunds of a payment Mollie does not have", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  for (const [action, run] of ACTIONS) {
    it(`refuses a ${action} of a malformed payment id without calling Mollie`, async () => {
      await Rejected(run(MALFORMED), PaymentNotFoundError);
      await delay(IN_FLIGHT_MS);
      assert.equal(requestsNaming(MALFORMED), 0);
    });

    it(`reports a ${action} of an absent payment as not found`, async () => {
      const error = await Rejected(run(ABSENT), PaymentNotFoundError);
      assert.match(error.message, new RegExp(ABSENT));
    });
  }
});

describe("[mollie] two reads run together", () => {
  it("fails with the first read's error even when the second fails sooner", async () => {
    const first = delay(IN_FLIGHT_MS / 10).then(() => {
      throw new Error("first read");
    });
    const second = Promise.reject(new Error("second read"));
    await assert.rejects(InTurnOrder(first, second), /first read/);
  });

  it("fails with the second read's error when only it fails", async () => {
    await assert.rejects(
      InTurnOrder(Promise.resolve(1), Promise.reject(new Error("second read"))),
      /second read/,
    );
  });
});
