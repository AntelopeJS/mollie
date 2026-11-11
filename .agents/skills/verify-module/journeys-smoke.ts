import type { Journey } from "@antelopejs/tooling-configs/verify";

import { EUR, RETURN_URL, answered, call, callsOf, callsTo, fresh, paymentAtProvider, pick, same, settle, settleDelivered, text, withSession } from "./session.ts";

const payReadBack: Journey = {
  title: "one payment created through core reaches Mollie under the account's key and reads back succeeded once the payer pays it",
  entryPoint: "`CreatePayment` and `GetPayment` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const created = await call(session, "CreatePayment", "CreatePayment", [{ amount: EUR, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      const id = text(pick(created.value, "id"));
      await settle(session, id, "paid");
      const read = await call(session, "GetPayment", "GetPayment", [id, null]);
      context.expect(read.folder, [
        answered(created),
        same("Mollie holds the payment the module created", pick(await paymentAtProvider(session, id), "id"), id),
        same("the module read it back succeeded", pick(read.value, "status"), "succeeded"),
        same("the creating request went to the payments endpoint once", callsTo(session, "POST", "/v2/payments").length, 1),
      ]);
    });
  },
};

const requestContract: Journey = {
  title: "a request to Mollie is a POST carrying the payment as its body, under the account's API key as a bearer token, to the configured API URL",
  entryPoint: "`CreatePayment` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const key = fresh("key");
      const created = await call(session, "CreatePayment", "CreatePayment", [{ amount: EUR, reference: fresh("order"), returnUrl: RETURN_URL }, key, null]);
      const sent = callsTo(session, "POST", "/v2/payments");
      context.expect(created.folder, [
        answered(created),
        same("Mollie, at the configured API URL, took one POST to the payments endpoint under the account's key", sent.length, 1),
        same("no request went out under the other account's key", callsOf(session, "second").length, 0),
        same("the body is the JSON object of the payment asked for", [pick(sent[0]?.body, "amount"), pick(sent[0]?.body, "redirectUrl")], [{ currency: "EUR", value: "10.50" }, RETURN_URL]),
        same("the idempotency key is the one the caller passed", sent[0]?.idempotencyKey ?? null, key),
      ]);
    });
  },
};

const sandboxLive: Journey = {
  title: "a payment created through core reaches Mollie's test mode under the operator's test key, the payer completes its checkout at Mollie, and it reads back succeeded",
  entryPoint: "`CreatePayment` and `GetPayment` through core against api.mollie.com with a test_ API key, the checkout completed in a browser",
  async run(context) {
    await withSession(context, async (session) => {
      if (session.target.kind !== "live") context.notVerified("the session does not run against Mollie's test mode");
      const key = fresh("key");
      const created = await call(session, "CreatePayment", "CreatePayment", [{ amount: EUR, reference: fresh("order"), returnUrl: RETURN_URL }, key, null]);
      const id = text(pick(created.value, "id"));
      const held = await paymentAtProvider(session, id);
      const sent = callsTo(session, "POST", "/v2/payments");
      context.expect(created.folder, [
        answered(created),
        same("Mollie's test mode holds the payment as created, open for 10.50 EUR", [pick(held, "id"), pick(held, "mode"), pick(held, "status"), pick(held, "amount")], [id, "test", "open", { currency: "EUR", value: "10.50" }]),
        same("the payer is sent to Mollie's own checkout", new URL(text(pick(created.value, "redirectUrl")) || "about:blank").hostname, "www.mollie.com"),
        same("the creating request reached Mollie once, under the caller's idempotency key", [sent.length, sent[0]?.idempotencyKey ?? null], [1, key]),
      ], { critical: true });
      const delivery = await settleDelivered(session, id, "paid");
      const read = await call(session, "GetPayment", "GetPayment", [id, null]);
      context.expect(read.folder, [
        delivery,
        answered(read),
        same("once the payer paid at Mollie the payment reads succeeded with the whole amount captured", [pick(read.value, "status"), pick(read.value, "amountCaptured")], ["succeeded", EUR]),
        same("Mollie holds it paid", pick(await paymentAtProvider(session, id), "status"), "paid"),
      ]);
    });
  },
};

export const smokeJourneys = { "pay-read-back": payReadBack };
export const sandboxJourneys = { "request-contract": requestContract, "sandbox-live": sandboxLive };
