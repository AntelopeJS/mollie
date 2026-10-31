import type { Journey } from "@antelopejs/tooling-configs/verify";

import { EUR, PRIMARY_KEY, RETURN_URL, answered, call, callsTo, fresh, paymentAtProvider, pick, same, settle, text, withSession } from "./session.ts";

const payThroughStandIn: Journey = {
  title: "one payment created through core reaches the stand-in for Mollie under the account's key and reads back succeeded once Mollie settles it",
  entryPoint: "`CreatePayment` and `GetPayment` through core against the stand-in for Mollie",
  async run(context) {
    await withSession(context, async (session) => {
      const created = await call(session, "CreatePayment", "CreatePayment", [{ amount: EUR, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      const id = text(pick(created.value, "id"));
      settle(session, id, "paid");
      const read = await call(session, "GetPayment", "GetPayment", [id, null]);
      context.expect(read.folder, [
        answered(created),
        same("Mollie holds the payment the module created", pick(await paymentAtProvider(session, id), "id"), id),
        same("the module read it back succeeded", pick(read.value, "status"), "succeeded"),
        same("the creating request went to the payments endpoint once", callsTo(session, "POST", "/v2/payments", PRIMARY_KEY).length, 1),
      ]);
    });
  },
};

const requestContract: Journey = {
  title: "a request to Mollie is a JSON POST under the account's API key as a bearer token, to the configured API URL",
  entryPoint: "`CreatePayment` through core against the stand-in for Mollie",
  async run(context) {
    await withSession(context, async (session) => {
      const created = await call(session, "CreatePayment", "CreatePayment", [{ amount: EUR, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      context.expect(created.folder, [
        answered(created),
        same("the stand-in, which refuses any other key, answered the payment request with a success", callsTo(session, "POST", "/v2/payments").length, 1),
      ]);
    });
  },
};

const sandboxLive: Journey = {
  title: "the module against Mollie's own test mode",
  entryPoint: "`CreatePayment` against api.mollie.com with a test_ API key",
  run(context) {
    return Promise.resolve(
      context.notVerified("no journey reaches Mollie's test mode: it needs the merchant's test_ API key, which only the operator holds; the module's own `pnpm test` runs live with MOLLIE_API_KEY"),
    );
  },
};

export const smokeJourneys = { "pay-through-stand-in": payThroughStandIn };
export const sandboxJourneys = { "request-contract": requestContract, "sandbox-live": sandboxLive };
