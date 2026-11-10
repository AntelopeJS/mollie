import assert from "node:assert/strict";
import { GetPayment } from "@antelopejs/interface-payment";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  ListSubscriptions,
  SubscriptionPaymentError,
  type SubscriptionRequest,
} from "@antelopejs/interface-subscriptions";

import { NewPayer, type Payer } from "./support/payers";
import { ParsePaymentMethodId, SubscriptionId } from "../mollie/ids";
import {
  Key,
  PrimaryAccount,
  Reference,
  Rejected,
  RequireStandIn,
  StandIn,
  TEST_TIMEOUT,
} from "./support/helpers";
import "./support/relay";

const PERIOD = { value: 1900, currency: "EUR" };
const SUBSCRIPTION_PATH = /^\/v2\/customers\/[^/]+\/subscriptions\/[^/]+$/;

type Breakage = () => () => void;

function request(payer: Payer): SubscriptionRequest {
  return {
    reference: Reference(),
    customer: payer.customer,
    paymentMethod: payer.paymentMethod,
    amount: PERIOD,
    interval: "month",
  };
}

function mandateOf(payer: Payer): string {
  return ParsePaymentMethodId(payer.paymentMethod)?.child ?? "";
}

function atMollie(customer: string, status: string): string[] {
  return [...PrimaryAccount().subscriptions.values()]
    .filter(
      (subscription) =>
        subscription.customerId === customer && subscription.status === status,
    )
    .map((subscription) => SubscriptionId(customer, subscription.id));
}

const loseRefusedMarkAnswer: Breakage = () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const sent = new Request(input, init);
    const response = await real(input, init);
    const isRefusedMark =
      sent.method === "PATCH" &&
      SUBSCRIPTION_PATH.test(new URL(sent.url).pathname) &&
      (await sent.text()).includes('"refused"');
    if (isRefusedMark) throw new TypeError("fetch failed: the answer was lost");
    return response;
  };
  return () => {
    globalThis.fetch = real;
  };
};

const failCancel: Breakage = () => {
  StandIn().faults.push({
    method: "DELETE",
    path: SUBSCRIPTION_PATH,
    status: 503,
  });
  return () => undefined;
};

async function refuseHalfway(
  payer: Payer,
  breakage: Breakage,
): Promise<{ body: SubscriptionRequest; key: string }> {
  const body = request(payer);
  const key = Key();
  PrimaryAccount().declinesAtCreation.add(mandateOf(payer));
  const restore = breakage();
  try {
    await assert.rejects(CreateSubscription(body, key));
  } finally {
    restore();
    PrimaryAccount().declinesAtCreation.delete(mandateOf(payer));
  }
  return { body, key };
}

const HALFWAY_REFUSALS: [string, Breakage][] = [
  ["the answer to its refused mark is lost", loseRefusedMarkAnswer],
  ["its cancel fails before Mollie applies it", failCancel],
];

describe("[mollie] a refusal that stops before its cancel", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  for (const [how, breakage] of HALFWAY_REFUSALS) {
    it(`lists, reads and cancels the subscription Mollie still bills when ${how}`, async () => {
      const payer = await NewPayer();
      await refuseHalfway(payer, breakage);
      const billing = atMollie(payer.customer, "active");
      assert.equal(billing.length, 1, "Mollie bills the subscription");

      const listed = await ListSubscriptions(payer.customer);
      assert.deepEqual(
        listed.map((subscription) => subscription.id),
        billing,
      );
      const read = await GetSubscription(billing[0] ?? "");
      assert.equal(read.status, "past_due");
      assert.equal(
        (await GetPayment(read.latestPayment ?? "")).status,
        "failed",
        "the declined first charge is the latest payment",
      );

      const canceled = await CancelSubscription(read.id, Key(), "now");
      assert.equal(canceled.status, "canceled");
      assert.equal((await GetSubscription(read.id)).status, "canceled");
      assert.deepEqual(atMollie(payer.customer, "active"), []);
    });
  }

  it("hides the subscription again once a replay of the key cancels it", async () => {
    const payer = await NewPayer();
    const { body, key } = await refuseHalfway(payer, loseRefusedMarkAnswer);

    await Rejected(CreateSubscription(body, key), SubscriptionPaymentError);
    assert.deepEqual(atMollie(payer.customer, "active"), []);
    assert.equal(atMollie(payer.customer, "canceled").length, 1);
    assert.deepEqual(await ListSubscriptions(payer.customer), []);
  });
});
