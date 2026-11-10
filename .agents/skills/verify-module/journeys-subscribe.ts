import type { Journey } from "@antelopejs/tooling-configs/verify";

import { isNumber, answered, call, callsTo, fresh, settleDelivered, pick, same, savedMethod, subscription, text, thrown, withSession, wire, type Json } from "./session.ts";
import { MONTHLY, amsterdamClock, monthAfter, requestOf, subscriptionAtProvider } from "./journeys-subscriptions-shared.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const subscribeCharged: Journey = {
  title: "a subscription on a saved method is one Mollie subscription that starts a period from today, with the first period charged at once as a recurring payment, and reads back active",
  entryPoint: "`CreateSubscription`, `GetSubscription` and `ListSubscriptions` through core on a customer with a saved card",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const key = fresh("sub");
      const dayBefore = amsterdamClock(Date.now())?.[0];
      const created = await subscription(session, "CreateSubscription", "CreateSubscription", [requestOf(saved, { description: "Pro plan" }), key, null]);
      const dayAfter = amsterdamClock(Date.now())?.[0];
      const id = text(pick(created.value, "id"));
      const periodStart = amsterdamClock(pick(created.value, "currentPeriodStart"));
      const periodEnd = amsterdamClock(pick(created.value, "currentPeriodEnd"));
      context.expect(created.folder, [
        same("the period it reports starts at midnight on today's Amsterdam date", [periodStart?.[1] ?? null, periodStart !== null && (periodStart[0] === dayBefore || periodStart[0] === dayAfter)], ["00:00:00", true]),
        same("the period ends at midnight one month later", [periodEnd?.[1] ?? null, periodStart === null ? null : periodEnd?.[0]], ["00:00:00", periodStart === null ? null : monthAfter(periodStart[0])]),
      ]);
      context.expect(created.folder, [
        answered(created),
        same("the subscription is active on the customer's saved method for 19.00 a month", [pick(created.value, "status"), pick(created.value, "customer"), pick(created.value, "paymentMethod"), pick(created.value, "amount"), pick(created.value, "interval"), pick(created.value, "intervalCount")], ["active", saved.customer, saved.method, MONTHLY, "month", 1]),
        same("the first period is charged: the subscription has a latest payment", text(pick(created.value, "latestPayment")).startsWith("tr_"), true),
        same("nothing is cancelled or ending", [pick(created.value, "cancelAtPeriodEnd"), pick(created.value, "endedAt") ?? null], [false, null]),
      ], { critical: true });
      const held = await subscriptionAtProvider(session, id);
      const first = callsTo(session, "POST", "/v2/payments").at(-1);
      context.expect(created.folder, [
        same("Mollie holds one active subscription of 19.00 every month", [pick(held, "status"), pick(held, "amount"), pick(held, "interval")], ["active", { currency: "EUR", value: "19.00" }, "1 month"]),
        same("it describes itself with the caller's description and reference", text(pick(held, "description")).startsWith("Pro plan ("), true),
        same("Mollie was asked to charge the first period as a recurring payment on that customer and mandate", [pick(first?.body, "sequenceType"), pick(first?.body, "customerId"), pick(first?.body, "amount")], ["recurring", saved.customer, { currency: "EUR", value: "19.00" }]),
      ]);
      const delivery = await settleDelivered(session, text(pick(created.value, "latestPayment")), "paid");
      const read = await subscription(session, "GetSubscription", "GetSubscription", [id, null]);
      const listed = await subscription(session, "ListSubscriptions", "ListSubscriptions", [saved.customer, null]);
      context.expect(listed.folder, [
        delivery,
        same("reading it back gives the same subscription, still active after the first charge was paid", [pick(read.value, "id"), pick(read.value, "status")], [id, "active"]),
        same("the customer has exactly this subscription", [Array.isArray(listed.value) ? listed.value.length : -1, pick(listed.value, 0, "id")], [1, id]),
      ]);
    });
  },
};

const subscribeReplay: Journey = {
  title: "creating a subscription twice with one idempotency key returns the same subscription and leaves one subscription and one first charge at Mollie; a new key is a new subscription",
  entryPoint: "`CreateSubscription` twice with one key, then once under another, through core",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const key = fresh("sub");
      const request = requestOf(saved);
      const first = await subscription(session, "CreateSubscription", "CreateSubscription", [request, key, null]);
      const replay = await subscription(session, "CreateSubscription replayed", "CreateSubscription", [request, key, null]);
      const charges = callsTo(session, "POST", "/v2/payments").filter((entry) => pick(entry.body, "sequenceType") === "recurring");
      const [customerId] = text(pick(first.value, "id")).split(":");
      const atMollie = await wire(session, "GET", `/v2/customers/${customerId}/subscriptions`);
      context.expect(replay.folder, [
        answered(first),
        answered(replay),
        same("the replay returns the first subscription", pick(replay.value, "id"), pick(first.value, "id")),
        same("Mollie holds one subscription", pick(atMollie.json, "count"), 1),
        same("the first period was charged once", charges.length, 1),
        same("the replay returns the first charge as the latest payment", pick(replay.value, "latestPayment"), pick(first.value, "latestPayment")),
      ]);
      const other = await subscription(session, "CreateSubscription under another key", "CreateSubscription", [{ ...request, reference: fresh("sub2") }, fresh("sub"), null]);
      const listed = await subscription(session, "ListSubscriptions", "ListSubscriptions", [customerId, null]);
      context.expect(listed.folder, [
        same("another key is another subscription", pick(other.value, "id") === pick(first.value, "id"), false),
        same("the customer has both, newest first", [Array.isArray(listed.value) ? listed.value.length : -1, pick(listed.value, 0, "id")], [2, pick(other.value, "id") ?? null]),
      ]);
    });
  },
};

const subscribeSchedule: Journey = {
  title: "a trial or billing anchor defers the first charge to the next Amsterdam day, a year is twelve months at Mollie and a year when read back, and a period longer than Mollie bills is refused before any request",
  entryPoint: "`CreateSubscription` with a trial end, a billing anchor, a year and over-long periods through core",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const trialEnd = Date.now() + 3 * DAY_MS + 5 * 60 * 60 * 1000;
      const trial = await subscription(session, "CreateSubscription with a trial", "CreateSubscription", [requestOf(saved, { trialEnd }), fresh("sub"), null]);
      const trialAtMollie = await subscriptionAtProvider(session, text(pick(trial.value, "id")));
      const trialEndsAt = pick(trial.value, "trialEnd");
      context.expect(trial.folder, [
        answered(trial),
        same("the subscription is trialing and charges nothing yet", [pick(trial.value, "status"), pick(trial.value, "latestPayment") ?? null], ["trialing", null]),
        same("the trial ends at or after the time asked, less than a day later", isNumber(trialEndsAt) && trialEndsAt >= trialEnd && trialEndsAt - trialEnd < DAY_MS, true),
        same("the first period ends when the trial does", pick(trial.value, "currentPeriodEnd"), trialEndsAt ?? null),
        same("Mollie starts the schedule on that calendar day", pick(trialAtMollie, "startDate"), isNumber(trialEndsAt) ? new Date(trialEndsAt + 2 * 60 * 60 * 1000).toISOString().slice(0, 10) : null),
      ], { critical: true });
      const billingAnchor = Date.now() + 2 * DAY_MS + 60 * 60 * 1000;
      const chargesBefore = callsTo(session, "POST", "/v2/payments").length;
      const anchored = await subscription(session, "CreateSubscription with an anchor", "CreateSubscription", [requestOf(saved, { billingAnchor }), fresh("sub"), null]);
      const anchoredAtMollie = await subscriptionAtProvider(session, text(pick(anchored.value, "id")));
      const anchorEnd = pick(anchored.value, "currentPeriodEnd");
      context.expect(anchored.folder, [
        same("an anchored subscription is active and charged nothing yet", [pick(anchored.value, "status"), pick(anchored.value, "latestPayment") ?? null, pick(anchored.value, "trialEnd") ?? null], ["active", null, null]),
        same("no payment request reached Mollie for it", callsTo(session, "POST", "/v2/payments").length, chargesBefore),
        same("its first period ends at or after the anchor, less than a day later", isNumber(anchorEnd) && anchorEnd >= billingAnchor && anchorEnd - billingAnchor < DAY_MS, true),
        same("Mollie starts the schedule on that Amsterdam day", pick(anchoredAtMollie, "startDate"), amsterdamClock(anchorEnd)?.[0] ?? null),
      ]);
      const yearly = await subscription(session, "CreateSubscription yearly", "CreateSubscription", [requestOf(saved, { interval: "year" }), fresh("sub"), null]);
      context.expect(yearly.folder, [
        same("a year reads back as a year", [pick(yearly.value, "interval"), pick(yearly.value, "intervalCount")], ["year", 1]),
        same("Mollie bills it every twelve months", pick(await subscriptionAtProvider(session, text(pick(yearly.value, "id"))), "interval"), "12 months"),
      ]);
      const before = callsTo(session, "POST", "/v2/customers/" + saved.customer + "/subscriptions").length;
      const tooLong: [string, number][] = [["year", 2], ["week", 53], ["month", 13], ["day", 366]];
      const refusals: Json[] = [];
      for (const [interval, intervalCount] of tooLong) {
        const refused = await subscription(session, `CreateSubscription every ${intervalCount} ${interval}s`, "CreateSubscription", [requestOf(saved, { interval, intervalCount }), fresh("sub"), null]);
        refusals.push(pick(thrown(refused), 0) ?? null);
      }
      context.expect(yearly.folder, [
        same("a period Mollie cannot bill is an InvalidSubscriptionRequestError, for years, weeks, months and days", refusals, tooLong.map(() => "InvalidSubscriptionRequestError")),
        same("no subscription request reached Mollie for them", callsTo(session, "POST", "/v2/customers/" + saved.customer + "/subscriptions").length, before),
      ]);
    });
  },
};

const subscribeRefused: Journey = {
  title: "a payment method that is not the customer's, or not a saved method, is an invalid subscription request and nothing is created",
  entryPoint: "`CreateSubscription` with another customer's method and a malformed one through core",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const stranger = await call(session, "CreateCustomer for another payer", "CreateCustomer", [{ email: `${fresh("other")}@merchant.invalid` }, fresh("key"), null]);
      const strangerId = text(pick(stranger.value, "id"));
      const foreign = await subscription(session, "CreateSubscription with another customer's method", "CreateSubscription", [requestOf({ customer: strangerId, method: saved.method }), fresh("sub"), null]);
      const malformed = await subscription(session, "CreateSubscription with a malformed method", "CreateSubscription", [requestOf({ customer: saved.customer, method: "not-a-method" }), fresh("sub"), null]);
      const listed = await subscription(session, "ListSubscriptions", "ListSubscriptions", [saved.customer, null]);
      context.expect(listed.folder, [
        same("another customer's method is refused", pick(thrown(foreign), 0), "InvalidSubscriptionRequestError"),
        same("a malformed method is refused", pick(thrown(malformed), 0), "InvalidSubscriptionRequestError"),
        same("the customer has no subscription", Array.isArray(listed.value) ? listed.value.length : -1, 0),
      ]);
    });
  },
};

const subscribeDeclined: Journey = {
  title: "a first charge that Mollie declines afterwards leaves the subscription past_due and is not retried",
  entryPoint: "`CreateSubscription`, then Mollie declining the first charge, then `GetSubscription` through core",
  async run(context) {
    await withSession(
      context,
      async (session) => {
        const saved = await savedMethod(session, "saved card");
        const created = await subscription(session, "CreateSubscription", "CreateSubscription", [requestOf(saved), fresh("sub"), null]);
        const id = text(pick(created.value, "id"));
        const chargeId = text(pick(created.value, "latestPayment"));
        const delivery = await settleDelivered(session, chargeId, "failed");
        const read = await subscription(session, "GetSubscription after the decline", "GetSubscription", [id, null]);
        context.expect(read.folder, [
          delivery,
          answered(created),
          same("the subscription is past due", pick(read.value, "status"), "past_due"),
          same("it keeps the declined charge as its latest payment", pick(read.value, "latestPayment"), chargeId),
          same("the module charged the first period only once", callsTo(session, "POST", "/v2/payments").filter((entry) => pick(entry.body, "sequenceType") === "recurring").length, 1),
        ]);
      },
      { standIn: "charge-paid-at-creation" },
    );
  },
};

export const subscribeJourneys = {
  "subscribe-charged": subscribeCharged,
  "subscribe-replay": subscribeReplay,
  "subscribe-schedule": subscribeSchedule,
  "subscribe-refused": subscribeRefused,
  "subscribe-declined": subscribeDeclined,
};
