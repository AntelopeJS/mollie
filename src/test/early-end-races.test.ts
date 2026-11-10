import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  type SubscriptionRequest,
} from "@antelopejs/interface-subscriptions";

import { NewPayer, type Payer } from "./support/payers";
import {
  Key,
  Reference,
  RequireStandIn,
  TEST_TIMEOUT,
} from "./support/helpers";
import "./support/relay";

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD = { value: 1900, currency: "EUR" };
const PARTNER_WAIT_MS = 500;

type Send = () => Promise<Response>;
type Gate = (method: string, url: URL, send: Send) => Promise<Response>;

interface Latch {
  promise: Promise<void>;
  open: () => void;
}

function latch(): Latch {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function intercept(gate: Gate): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    return gate(init?.method ?? "GET", new URL(href), () => real(input, init));
  };
  return () => {
    globalThis.fetch = real;
  };
}

function request(
  payer: Payer,
  overrides: Partial<SubscriptionRequest> = {},
): SubscriptionRequest {
  return {
    reference: Reference(),
    customer: payer.customer,
    paymentMethod: payer.paymentMethod,
    amount: PERIOD,
    interval: "month",
    ...overrides,
  };
}

describe("[mollie] concurrent early ends", function () {
  this.timeout(TEST_TIMEOUT);

  before(function () {
    RequireStandIn(this);
  });

  it("keeps both early ends when two now-cancellations of one customer's subscriptions overlap", async () => {
    const payer = await NewPayer();
    const first = await CreateSubscription(request(payer), Key());
    const second = await CreateSubscription(
      request(payer, { billingAnchor: Date.now() + 40 * DAY_MS }),
      Key(),
    );
    await CancelSubscription(first.id, Key(), "period_end");
    await CancelSubscription(second.id, Key(), "period_end");

    const partnerWriting = latch();
    const firstReturned = latch();
    let writes = 0;
    const restore = intercept(async (method, url, send) => {
      if (
        method !== "PATCH" ||
        url.pathname !== `/v2/customers/${payer.customer}`
      )
        return send();
      writes += 1;
      if (writes === 1) {
        await Promise.race([partnerWriting.promise, delay(PARTNER_WAIT_MS)]);
        return send();
      }
      partnerWriting.open();
      await firstReturned.promise;
      return send();
    });
    try {
      const endings = [
        CancelSubscription(first.id, Key(), "now"),
        CancelSubscription(second.id, Key(), "now"),
      ];
      await Promise.race(endings).finally(firstReturned.open);
      const returned = await Promise.all(endings);
      assert.deepEqual(
        returned.map((ended) => ended.status),
        ["canceled", "canceled"],
        "both early ends returned canceled",
      );
    } finally {
      restore();
    }

    const read = await Promise.all(
      [first, second].map((subscription) => GetSubscription(subscription.id)),
    );
    assert.deepEqual(
      read.map((ended) => [ended.status, ended.cancelAtPeriodEnd]),
      [
        ["canceled", false],
        ["canceled", false],
      ],
      "both early ends are still recorded",
    );
  });
});
