import type { Journey } from "@antelopejs/tooling-configs/verify";

import { WEBHOOK_URL, isNumber, RETURN_URL, answered, call, fresh, pick, same, savedMethod, settle, subscription, text, thrown, withSession, wire } from "./session.ts";
import { requestOf, subscriptionAtProvider } from "./journeys-subscriptions-shared.ts";

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
      await settle(session, text(pick(second.value, "id")), "paid");
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
      const foreign = await wire(session, "POST", `/v2/customers/${saved.customer}/subscriptions`, "primary", {
        amount: { currency: "EUR", value: "5.00" },
        interval: "1 month",
        description: "Made in the dashboard",
        mandateId: mandate,
        webhookUrl: WEBHOOK_URL,
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

export const subscriptionLifecycleJourneys = {
  "cancel-now": cancelNow,
  "cancel-period-end": cancelPeriodEnd,
  "change-method": changeMethod,
  "subscribe-own": subscribeOwn,
};
