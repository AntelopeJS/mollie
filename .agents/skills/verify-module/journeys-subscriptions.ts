import type { Journey } from "@antelopejs/tooling-configs/verify";

import { PRIMARY_KEY, isNumber, RETURN_URL, answered, call, callsTo, fresh, pause, pick, same, savedMethod, settle, subscription, text, thrown, withSession, wire, type Json, type Session } from "./session.ts";

const MONTHLY = { value: 1900, currency: "EUR" };
const DAY_MS = 24 * 60 * 60 * 1000;

function requestOf(saved: { customer: string; method: string }, extra: Record<string, Json> = {}) {
  return { reference: fresh("sub"), customer: saved.customer, paymentMethod: saved.method, amount: MONTHLY, interval: "month", ...extra };
}

/** What Mollie holds for a subscription, read with the account's key and not through the module. */
async function subscriptionAtProvider(session: Session, id: string): Promise<Json> {
  const [customer, child] = id.split(":");
  return (await wire(session.base, "GET", `/v2/customers/${customer}/subscriptions/${child}`, PRIMARY_KEY)).json;
}

const subscribeCharged: Journey = {
  title: "a subscription on a saved method is one Mollie subscription that starts a period from today, with the first period charged at once as a recurring payment, and reads back active",
  entryPoint: "`CreateSubscription`, `GetSubscription` and `ListSubscriptions` through core on a customer with a saved card",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const key = fresh("sub");
      const created = await subscription(session, "CreateSubscription", "CreateSubscription", [requestOf(saved, { description: "Pro plan" }), key, null]);
      const id = text(pick(created.value, "id"));
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
      settle(session, text(pick(created.value, "latestPayment")), "paid");
      await pause(500);
      const read = await subscription(session, "GetSubscription", "GetSubscription", [id, null]);
      const listed = await subscription(session, "ListSubscriptions", "ListSubscriptions", [saved.customer, null]);
      context.expect(listed.folder, [
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
      const atMollie = await wire(session.base, "GET", `/v2/customers/${customerId}/subscriptions`, PRIMARY_KEY);
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
      const anchored = await subscription(session, "CreateSubscription with an anchor", "CreateSubscription", [requestOf(saved, { billingAnchor: Date.now() + 2 * DAY_MS + 60 * 60 * 1000 }), fresh("sub"), null]);
      context.expect(anchored.folder, [
        same("an anchored subscription is active and charged nothing yet", [pick(anchored.value, "status"), pick(anchored.value, "latestPayment") ?? null, pick(anchored.value, "trialEnd") ?? null], ["active", null, null]),
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
        same("a period Mollie cannot bill is an InvalidSubscriptionRequestError, for years, weeks and months", refusals.slice(0, 3), ["InvalidSubscriptionRequestError", "InvalidSubscriptionRequestError", "InvalidSubscriptionRequestError"]),
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
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const created = await subscription(session, "CreateSubscription", "CreateSubscription", [requestOf(saved), fresh("sub"), null]);
      const id = text(pick(created.value, "id"));
      const chargeId = text(pick(created.value, "latestPayment"));
      settle(session, chargeId, "failed");
      await pause(500);
      const read = await subscription(session, "GetSubscription after the decline", "GetSubscription", [id, null]);
      context.expect(read.folder, [
        answered(created),
        same("the subscription is past due", pick(read.value, "status"), "past_due"),
        same("it keeps the declined charge as its latest payment", pick(read.value, "latestPayment"), chargeId),
        same("the module charged the first period only once", callsTo(session, "POST", "/v2/payments").filter((entry) => pick(entry.body, "sequenceType") === "recurring").length, 1),
      ]);
    });
  },
};

const cancelNow: Journey = {
  title: "cancelling now ends the subscription at Mollie with the reason requested; cancelling again with the same key returns it, with another key is a state error",
  entryPoint: "`CancelSubscription` with timing `now` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const created = await subscription(session, "CreateSubscription", "CreateSubscription", [requestOf(saved), fresh("sub"), null]);
      const id = text(pick(created.value, "id"));
      const key = fresh("cancel");
      const canceled = await subscription(session, "CancelSubscription now", "CancelSubscription", [id, key, "now", null]);
      context.expect(canceled.folder, [
        answered(canceled),
        same("the subscription is canceled for the reason requested, with an end time", [pick(canceled.value, "status"), pick(canceled.value, "endReason"), isNumber(pick(canceled.value, "endedAt"))], ["canceled", "requested", true]),
        same("Mollie holds it as canceled", pick(await subscriptionAtProvider(session, id), "status"), "canceled"),
      ], { critical: true });
      const replay = await subscription(session, "CancelSubscription replayed", "CancelSubscription", [id, key, "now", null]);
      const again = await subscription(session, "CancelSubscription under another key", "CancelSubscription", [id, fresh("cancel"), "now", null]);
      const read = await subscription(session, "GetSubscription", "GetSubscription", [id, null]);
      context.expect(again.folder, [
        same("the same key returns the cancelled subscription", [pick(replay.value, "id"), pick(replay.value, "status")], [id, "canceled"]),
        same("another key on an ended subscription is an InvalidSubscriptionStateError", pick(thrown(again), 0), "InvalidSubscriptionStateError"),
        same("it still reads canceled", pick(read.value, "status"), "canceled"),
      ]);
    });
  },
};

const cancelPeriodEnd: Journey = {
  title: "cancelling at period end stops Mollie at once and reports the subscription as running until its period ends; cancelling now after that ends it early, and the early end stays on later reads",
  entryPoint: "`CancelSubscription` with timing `period_end`, then `now`, through core",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const created = await subscription(session, "CreateSubscription", "CreateSubscription", [requestOf(saved), fresh("sub"), null]);
      const id = text(pick(created.value, "id"));
      const periodEnd = pick(created.value, "currentPeriodEnd");
      const scheduled = await subscription(session, "CancelSubscription period_end", "CancelSubscription", [id, fresh("cancel"), "period_end", null]);
      context.expect(scheduled.folder, [
        answered(scheduled),
        same("it still runs and is flagged to end with its period", [pick(scheduled.value, "status"), pick(scheduled.value, "cancelAtPeriodEnd"), pick(scheduled.value, "currentPeriodEnd")], ["active", true, periodEnd ?? null]),
        same("Mollie has already cancelled it, so nothing is charged again", pick(await subscriptionAtProvider(session, id), "status"), "canceled"),
      ], { critical: true });
      const early = await subscription(session, "CancelSubscription now after period_end", "CancelSubscription", [id, fresh("cancel"), "now", null]);
      const read = await subscription(session, "GetSubscription after the early end", "GetSubscription", [id, null]);
      const customer = await call(session, "GetCustomer", "GetCustomer", [saved.customer, null]);
      context.expect(read.folder, [
        same("cancelling now ends it", [pick(early.value, "status"), pick(early.value, "endReason")], ["canceled", "requested"]),
        same("a later read still reports the early end", [pick(read.value, "status"), pick(read.value, "endedAt")], ["canceled", pick(early.value, "endedAt") ?? null]),
        same("the customer's own metadata is untouched by the record of the early end", pick(customer.value, "metadata") ?? null, null),
      ]);
    });
  },
};

const changeMethod: Journey = {
  title: "a subscription moves to another saved method of the same customer; a method of another customer is refused, and so is a change on a subscription set to end",
  entryPoint: "`UpdateSubscriptionPaymentMethod` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const second = await call(session, "first payment for a second card", "CreatePayment", [
        { amount: { value: 100, currency: "EUR" }, reference: fresh("first"), customer: saved.customer, savePaymentMethod: true, returnUrl: RETURN_URL },
        fresh("key"),
        null,
      ]);
      settle(session, text(pick(second.value, "id")), "paid");
      const methods = await call(session, "ListPaymentMethods", "ListPaymentMethods", [saved.customer, null]);
      const other = text(pick(methods.value, 0, "id")) === saved.method ? text(pick(methods.value, 1, "id")) : text(pick(methods.value, 0, "id"));
      const created = await subscription(session, "CreateSubscription", "CreateSubscription", [requestOf(saved), fresh("sub"), null]);
      const id = text(pick(created.value, "id"));
      const changed = await subscription(session, "UpdateSubscriptionPaymentMethod", "UpdateSubscriptionPaymentMethod", [id, other, fresh("change"), null]);
      const mandate = other.split(":")[1] ?? "";
      context.expect(changed.folder, [
        answered(changed),
        same("the subscription reports the new method", pick(changed.value, "paymentMethod"), other),
        same("Mollie charges the new mandate", pick(await subscriptionAtProvider(session, id), "mandateId"), mandate),
      ], { critical: true });
      const stranger = await call(session, "CreateCustomer for another payer", "CreateCustomer", [{ email: `${fresh("other")}@merchant.invalid` }, fresh("key"), null]);
      const foreign = await subscription(session, "UpdateSubscriptionPaymentMethod to another customer's method", "UpdateSubscriptionPaymentMethod", [id, `${text(pick(stranger.value, "id"))}:${mandate}`, fresh("change"), null]);
      await subscription(session, "CancelSubscription period_end", "CancelSubscription", [id, fresh("cancel"), "period_end", null]);
      const ending = await subscription(session, "UpdateSubscriptionPaymentMethod while ending", "UpdateSubscriptionPaymentMethod", [id, saved.method, fresh("change"), null]);
      context.expect(ending.folder, [
        same("another customer's method is refused", pick(thrown(foreign), 0), "InvalidSubscriptionRequestError"),
        same("a subscription set to end cannot change method", pick(thrown(ending), 0), "InvalidSubscriptionStateError"),
      ]);
    });
  },
};

const subscribeOwn: Journey = {
  title: "a subscription that was not made through the module is not listed, not found and not cancelled by it, and an unknown subscription is SubscriptionNotFoundError",
  entryPoint: "`ListSubscriptions`, `GetSubscription` and `CancelSubscription` through core after a subscription is made at Mollie directly",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const mandate = saved.method.split(":")[1] ?? "";
      const foreign = await wire(session.base, "POST", `/v2/customers/${saved.customer}/subscriptions`, PRIMARY_KEY, {
        amount: { currency: "EUR", value: "5.00" },
        interval: "1 month",
        description: "Made in the dashboard",
        mandateId: mandate,
        webhookUrl: "https://merchant.invalid/mollie/webhook",
      });
      const foreignId = `${saved.customer}:${text(pick(foreign.json, "id"))}`;
      const listed = await subscription(session, "ListSubscriptions", "ListSubscriptions", [saved.customer, null]);
      const read = await subscription(session, "GetSubscription of the dashboard subscription", "GetSubscription", [foreignId, null]);
      const canceled = await subscription(session, "CancelSubscription of the dashboard subscription", "CancelSubscription", [foreignId, fresh("cancel"), "now", null]);
      const unknown = await subscription(session, "GetSubscription of an unknown subscription", "GetSubscription", [`${saved.customer}:sub_nope123456`, null]);
      const malformed = await subscription(session, "GetSubscription of a malformed id", "GetSubscription", ["not-a-subscription", null]);
      context.expect(malformed.folder, [
        same("the module lists none of the account's other subscriptions", Array.isArray(listed.value) ? listed.value.length : -1, 0),
        same("it does not find the dashboard subscription", pick(thrown(read), 0), "SubscriptionNotFoundError"),
        same("it does not cancel it", pick(thrown(canceled), 0), "SubscriptionNotFoundError"),
        same("Mollie still holds it active", pick(await subscriptionAtProvider(session, foreignId), "status"), "active"),
        same("an unknown subscription is not found", pick(thrown(unknown), 0), "SubscriptionNotFoundError"),
        same("a malformed id is not found", pick(thrown(malformed), 0), "SubscriptionNotFoundError"),
      ]);
    });
  },
};

export const subscriptionJourneys = {
  "subscribe-charged": subscribeCharged,
  "subscribe-replay": subscribeReplay,
  "subscribe-schedule": subscribeSchedule,
  "subscribe-refused": subscribeRefused,
  "subscribe-declined": subscribeDeclined,
  "cancel-now": cancelNow,
  "cancel-period-end": cancelPeriodEnd,
  "change-method": changeMethod,
  "subscribe-own": subscribeOwn,
};
