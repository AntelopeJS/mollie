import type { Journey } from "@antelopejs/tooling-configs/verify";

import { PRIMARY_KEY, RETURN_URL, SECOND_ACCOUNT, SECOND_KEY, answered, call, callsOf, fresh, paymentAtProvider, pick, same, text, thrown, withSession, subscription, type Json } from "./session.ts";
import { requestOf } from "./journeys-subscriptions-shared.ts";

const accountSelection: Journey = {
  title: "a call that names a provider uses that account's key: the payment lives in the second account and not in the default one",
  entryPoint: "`CreatePayment` with and without the trailing `provider` selector through core",
  async run(context) {
    await withSession(context, async (session) => {
      const request = { amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL };
      const mine = await call(session, "CreatePayment on the default account", "CreatePayment", [request, fresh("key"), null]);
      const theirs = await call(session, "CreatePayment on the second account", "CreatePayment", [request, fresh("key"), SECOND_ACCOUNT]);
      const mineId = text(pick(mine.value, "id"));
      const theirsId = text(pick(theirs.value, "id"));
      const read = await call(session, "GetPayment of the second account's payment on the default account", "GetPayment", [theirsId, null]);
      context.expect(read.folder, [
        answered(mine),
        answered(theirs),
        same("the default account holds its own payment", pick(await paymentAtProvider(session, mineId, PRIMARY_KEY), "id"), mineId),
        same("the second account holds its own payment", pick(await paymentAtProvider(session, theirsId, SECOND_KEY), "id"), theirsId),
        same("the default account does not see the second one's payment", pick(await paymentAtProvider(session, theirsId, PRIMARY_KEY), "status"), 404),
        same("reading it without naming the provider is not found", pick(thrown(read), 0), "PaymentNotFoundError"),
      ]);
    });
  },
};

const unknownProvider: Journey = {
  title: "a provider nobody configured is a PaymentError that names it (a SubscriptionError from the subscription functions), and nothing reaches Mollie",
  entryPoint: "`GetPayment` and each subscription function with a provider selector that no account has, through core",
  async run(context) {
    await withSession(context, async (session) => {
      const refused = await call(session, "GetPayment on an unknown provider", "GetPayment", ["tr_nope123456", "nobody"]);
      const id = "cst_nope123456:sub_nope123456";
      const saved = { customer: "cst_nope123456", method: "cst_nope123456:mdt_nope123456" };
      const subscriptionCalls: [string, Json[]][] = [
        ["CreateSubscription", [requestOf(saved), fresh("key"), "nobody"]],
        ["GetSubscription", [id, "nobody"]],
        ["ListSubscriptions", [saved.customer, "nobody"]],
        ["CancelSubscription", [id, fresh("key"), "now", "nobody"]],
        ["UpdateSubscriptionPaymentMethod", [id, saved.method, fresh("key"), "nobody"]],
      ];
      const refusals: Json[] = [];
      for (const [name, args] of subscriptionCalls) {
        refusals.push([name, thrown(await subscription(session, `${name} on an unknown provider`, name, args))]);
      }
      context.expect(refused.folder, [
        same("the refusal names the provider", thrown(refused), ["PaymentError", 'No Mollie account configured under "nobody"']),
        same(
          "every subscription function refuses it as a SubscriptionError naming the provider",
          refusals,
          subscriptionCalls.map(([name]) => [name, ["SubscriptionError", 'No Mollie account configured under "nobody"']]),
        ),
        same("no request reached Mollie under either key", [callsOf(session, PRIMARY_KEY).length, callsOf(session, SECOND_KEY).length], [0, 0]),
      ]);
    });
  },
};

const badKey: Journey = {
  title: "an API key Mollie does not know is a PaymentError carrying Mollie's refusal message, not a missing record",
  entryPoint: "`GetPayment` with a well-shaped key the stand-in does not know, through core",
  async run(context) {
    await withSession(
      context,
      async (session) => {
        const refused = await call(session, "GetPayment with an unknown key", "GetPayment", ["tr_nope123456", null]);
        context.expect(refused.folder, [same("a refused key is a PaymentError, not PaymentNotFoundError", [pick(thrown(refused), 0), pick(refused.json, "error", "message")], ["PaymentError", "Missing authentication, or failed to authenticate"])]);
      },
      { apiKey: `test_${"unknownkey".padEnd(30, "0")}` },
    );
  },
};

export const accountJourneys = {
  "account-selection": accountSelection,
  "unknown-provider": unknownProvider,
  "bad-key": badKey,
};
