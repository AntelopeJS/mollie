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

import { CurrentHarness } from "./support/harness";
import { NewPayer, type Payer } from "./support/payers";
import { ParsePaymentMethodId, SubscriptionId } from "../mollie/ids";
import {
  Eventually,
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

interface Latch {
  opened: Promise<void>;
  open: () => void;
}

/**
 * Holds the first call's `firstPayment` PATCH, and the replay's look for an
 * earlier charge, the second read of the customer's payments.
 */
interface Race {
  isMarkHeld: () => boolean;
  isLookupHeld: () => boolean;
  releaseMark: () => void;
  releaseLookup: () => void;
  restore: () => void;
}

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

function latch(): Latch {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function holdRace(customer: string): Race {
  const mark = latch();
  const lookup = latch();
  const held = { mark: false, lookup: false };
  let lookups = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const sent = new Request(input, init);
    const path = new URL(sent.url).pathname;
    const isMark =
      sent.method === "PATCH" &&
      SUBSCRIPTION_PATH.test(path) &&
      (await sent.text()).includes('"firstPayment"');
    if (isMark && !held.mark) {
      held.mark = true;
      await mark.opened;
    }
    if (
      sent.method === "GET" &&
      path === `/v2/customers/${customer}/payments`
    ) {
      lookups += 1;
      if (lookups === 2) {
        held.lookup = true;
        await lookup.opened;
      }
    }
    return real(input, init);
  };
  return {
    isMarkHeld: () => held.mark,
    isLookupHeld: () => held.lookup,
    releaseMark: mark.open,
    releaseLookup: lookup.open,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

function hasFailedFirstCharge(customer: string): boolean {
  return [...PrimaryAccount().payments.values()].some(
    (payment) =>
      payment.customerId === customer &&
      payment.sequenceType === "recurring" &&
      payment.status === "failed",
  );
}

const failRefusedMark: Breakage = () => {
  StandIn().faults.push({
    method: "PATCH",
    path: SUBSCRIPTION_PATH,
    status: 503,
  });
  return () => undefined;
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

  it("cancels at Mollie on replay when the refused mark never reached Mollie", async () => {
    const payer = await NewPayer();
    const { body, key } = await refuseHalfway(payer, failRefusedMark);
    assert.equal(atMollie(payer.customer, "active").length, 1);

    const replay = await Rejected(
      CreateSubscription(body, key),
      SubscriptionPaymentError,
    );
    assert.equal(replay.payment.status, "failed");
    assert.deepEqual(atMollie(payer.customer, "active"), []);
    assert.equal(atMollie(payer.customer, "canceled").length, 1);
  });
});

describe("[mollie] a replay racing the call it repeats", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("returns, lists and keeps billing the subscription the first call returned when its first charge fails between the two calls' reads", async () => {
    const payer = await NewPayer();
    CurrentHarness().policy.decliningMandates.add(mandateOf(payer));
    const race = holdRace(payer.customer);
    const body = request(payer);
    const key = Key();
    try {
      const creating = CreateSubscription(body, key);
      await Eventually(race.isMarkHeld, "the first call to send firstPayment");
      await Eventually(
        () => hasFailedFirstCharge(payer.customer),
        "the open first charge to fail",
      );
      const replaying = CreateSubscription(body, key);
      await Eventually(
        race.isLookupHeld,
        "the replay to read the subscription",
      );
      race.releaseMark();
      const first = await creating;
      race.releaseLookup();
      const [replayed] = await Promise.allSettled([replaying]);

      const listed = await ListSubscriptions(payer.customer);
      assert.deepEqual(
        listed.map((subscription) => subscription.id),
        [first.id],
        "the subscription the first call returned stays listed",
      );
      assert.equal(listed[0]?.status, "past_due");
      assert.deepEqual(atMollie(payer.customer, "active"), [first.id]);
      assert.equal(
        replayed.status === "fulfilled" && replayed.value.id,
        first.id,
        "the replay returns the same subscription",
      );
    } finally {
      race.restore();
      CurrentHarness().policy.decliningMandates.delete(mandateOf(payer));
    }
  });
});
