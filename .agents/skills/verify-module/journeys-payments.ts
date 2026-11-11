import type { Journey } from "@antelopejs/tooling-configs/verify";

import { EUR, PRIMARY_KEY, RETURN_URL, WEBHOOK_URL, answered, call, callsTo, fresh, paymentAtProvider, pick, same, settle, text, thrown, tuple, withSession, wire } from "./session.ts";

const payRedirect: Journey = {
  title: "a payment with no method becomes one open Mollie payment with the amount as a decimal string, the reference and webhook, and reads back as requires_action with Mollie's checkout link",
  entryPoint: "`CreatePayment` and `GetPayment` through core against the stand-in for Mollie",
  async run(context) {
    await withSession(context, async (session) => {
      const reference = fresh("order");
      const key = fresh("key");
      const created = await call(session, "CreatePayment", "CreatePayment", [{ amount: EUR, reference, returnUrl: RETURN_URL, description: "Verify order" }, key, null]);
      const id = text(pick(created.value, "id"));
      context.expect(created.folder, [
        answered(created),
        same("the amount and the reference are the request's", [pick(created.value, "amount"), pick(created.value, "reference")], [EUR, reference]),
        same("a payer-present payment is a redirect", pick(created.value, "status"), "requires_action"),
        same("the redirect is Mollie's checkout link", text(pick(created.value, "redirectUrl")).includes("/checkout/select-method/"), true),
      ], { critical: true });
      const held = await paymentAtProvider(session, id);
      context.expect(created.folder, [
        same("Mollie holds one open payment of 10.50 EUR", [pick(held, "status"), pick(held, "amount")], ["open", { currency: "EUR", value: "10.50" }]),
        same("it carries the redirect URL, the description and the configured webhook", [pick(held, "redirectUrl"), pick(held, "description"), pick(held, "webhookUrl")], [RETURN_URL, "Verify order", WEBHOOK_URL]),
        same("the reference travels in Mollie's metadata", pick(held, "metadata", "antelope", "reference"), reference),
        same("the creating request carried the caller's idempotency key", callsTo(session, "POST", "/v2/payments")[0]?.idempotencyKey ?? null, key),
      ]);
      const read = await call(session, "GetPayment", "GetPayment", [id, null]);
      context.expect(read.folder, [answered(read), same("reading it back gives the same status and link", [pick(read.value, "status"), pick(read.value, "redirectUrl")], tuple("requires_action", pick(created.value, "redirectUrl")))]);
    });
  },
};

const paySettles: Journey = {
  title: "once the payer pays Mollie the payment reads succeeded with the amount captured, a card Mollie declines reads failed with its reason renamed and Mollie's own kept, and a payment that expires reads canceled",
  entryPoint: "`GetPayment` through core after Mollie settles the payment as paid, as failed for Mollie's expired-card test amount (1004.00), and as expired",
  async run(context) {
    await withSession(context, async (session) => {
      const paid = await call(session, "CreatePayment to pay", "CreatePayment", [{ amount: EUR, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      const paidId = text(pick(paid.value, "id"));
      settle(session, paidId, "paid");
      const read = await call(session, "GetPayment of the paid payment", "GetPayment", [paidId, null]);
      context.expect(read.folder, [
        answered(read),
        same("the paid payment is succeeded with the whole amount captured", [pick(read.value, "status"), pick(read.value, "amountCaptured")], ["succeeded", EUR]),
        same("it no longer has a checkout link", pick(read.value, "redirectUrl") ?? null, null),
      ]);
      const declined = await call(session, "CreatePayment to decline", "CreatePayment", [
        { amount: { value: 100_400, currency: "EUR" }, reference: fresh("order"), paymentMethod: "creditcard", returnUrl: RETURN_URL },
        fresh("key"),
        null,
      ]);
      const declinedId = text(pick(declined.value, "id"));
      settle(session, declinedId, "failed");
      const failed = await call(session, "GetPayment of the declined payment", "GetPayment", [declinedId, null]);
      context.expect(failed.folder, [
        same("the payment is failed, not a thrown error", pick(failed.value, "status"), "failed"),
        same("the reason is renamed to the interface's and Mollie's own is kept", [pick(failed.value, "failure", "code"), pick(failed.value, "failure", "providerCode")], ["expired_card", "card_expired"]),
      ]);
      const lapsed = await call(session, "CreatePayment to expire", "CreatePayment", [{ amount: EUR, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      const lapsedId = text(pick(lapsed.value, "id"));
      settle(session, lapsedId, "expired");
      const expired = await call(session, "GetPayment of the expired payment", "GetPayment", [lapsedId, null]);
      context.expect(expired.folder, [
        answered(expired),
        same("a payment Mollie expired reads canceled", pick(expired.value, "status"), "canceled"),
      ]);
    });
  },
};

const payAmounts: Journey = {
  title: "amounts reach Mollie as strings with the currency's decimals: two for euros and forints, none for yen",
  entryPoint: "`CreatePayment` with EUR, HUF and JPY amounts through core, read back at the stand-in",
  async run(context) {
    await withSession(context, async (session) => {
      const sent: [string, number][] = [["EUR", 1050], ["HUF", 1050], ["JPY", 1050]];
      for (const [currency, value] of sent) {
        const created = await call(session, `CreatePayment in ${currency}`, "CreatePayment", [{ amount: { value, currency }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
        const held = await paymentAtProvider(session, text(pick(created.value, "id")));
        context.expect(created.folder, [
          answered(created),
          same(`Mollie holds the ${currency} amount in its own notation`, pick(held, "amount", "value"), currency === "JPY" ? "1050" : "10.50"),
          same(`the module reads it back as ${value} ${currency}`, pick(created.value, "amount"), { value, currency }),
        ]);
      }
    });
  },
};

const payIdempotent: Journey = {
  title: "creating a payment twice with one idempotency key returns the same payment and leaves one at Mollie; a new key makes a new one",
  entryPoint: "`CreatePayment` twice with one idempotency key, then once with another",
  async run(context) {
    await withSession(context, async (session) => {
      const key = fresh("key");
      const request = { amount: EUR, reference: fresh("order"), returnUrl: RETURN_URL };
      const first = await call(session, "CreatePayment", "CreatePayment", [request, key, null]);
      const replay = await call(session, "CreatePayment replayed", "CreatePayment", [request, key, null]);
      const other = await call(session, "CreatePayment under another key", "CreatePayment", [request, fresh("key"), null]);
      const listed = await wire(session.base, "GET", "/v2/payments", PRIMARY_KEY);
      context.expect(other.folder, [
        answered(first),
        answered(replay),
        same("the replay returns the first payment", pick(replay.value, "id"), pick(first.value, "id")),
        same("another key is another payment", pick(other.value, "id") === pick(first.value, "id"), false),
        same("Mollie holds two payments, not three", pick(listed.json, "count"), 2),
      ]);
    });
  },
};

const payNotFound: Journey = {
  title: "a payment Mollie does not have, and an id that cannot be Mollie's, are both PaymentNotFoundError, the second without a call",
  entryPoint: "`GetPayment` with an unknown id and a malformed one through core",
  async run(context) {
    await withSession(context, async (session) => {
      const unknown = await call(session, "GetPayment of an unknown id", "GetPayment", ["tr_nope123456", null]);
      context.expect(unknown.folder, [same("an unknown payment is a PaymentNotFoundError", pick(thrown(unknown), 0), "PaymentNotFoundError")]);
      const malformed = await call(session, "GetPayment of a malformed id", "GetPayment", ["not-a-payment", null]);
      context.expect(malformed.folder, [
        same("an id of the wrong shape is not found as well", pick(thrown(malformed), 0), "PaymentNotFoundError"),
        same("no request went out for it", callsTo(session, "GET", "/v2/payments/not-a-payment").length, 0),
      ]);
    });
  },
};

export const paymentJourneys = {
  "pay-redirect": payRedirect,
  "pay-settles": paySettles,
  "pay-amounts": payAmounts,
  "pay-idempotent": payIdempotent,
  "pay-not-found": payNotFound,
};
