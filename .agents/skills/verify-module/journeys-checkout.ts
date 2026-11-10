import type { Journey } from "@antelopejs/tooling-configs/verify";

import { RETURN_URL, WEBHOOK_URL, answered, call, callsTo, fresh, paymentAtProvider, pick, same, settle, text, withSession } from "./session.ts";

const hostedSession: Journey = {
  title: "a hosted checkout session is one Mollie payment with the success URL and the payer's language, and reads back as its payment settles",
  entryPoint: "`CreateCheckoutSession` and `GetCheckoutSession` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const created = await call(session, "CreateCheckoutSession", "CreateCheckoutSession", [
        { amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), successUrl: RETURN_URL, cancelUrl: `${RETURN_URL}/cancel`, locale: "fr", description: "Verify session" },
        fresh("key"),
        null,
      ]);
      const id = text(pick(created.value, "id"));
      const held = await paymentAtProvider(session, id);
      context.expect(created.folder, [
        answered(created),
        same("the session and its payment share one identifier", [pick(created.value, "payment"), text(pick(created.value, "redirectUrl")).includes("/checkout/")], [id, true]),
        same("the session needs the payer: requires_action", pick(created.value, "status"), "requires_action"),
        same("Mollie holds the payment with the success URL and the description", [pick(held, "redirectUrl"), pick(held, "description")], [RETURN_URL, "Verify session"]),
        same("French is preset in the region Mollie offers it in", pick(callsTo(session, "POST", "/v2/payments")[0]?.body, "locale"), "fr_FR"),
      ], { critical: true });
      const open = await call(session, "GetCheckoutSession open", "GetCheckoutSession", [id, null]);
      await settle(session, id, "paid");
      const paid = await call(session, "GetCheckoutSession paid", "GetCheckoutSession", [id, null]);
      context.expect(paid.folder, [
        same("the payment Mollie received carries the account's webhook URL", pick(callsTo(session, "POST", "/v2/payments")[0]?.body, "webhookUrl") ?? null, WEBHOOK_URL),
        same("the session follows its payment", [pick(open.value, "status"), pick(paid.value, "status")], ["requires_action", "succeeded"]),
      ]);
    });
  },
};

const sessionLocales: Journey = {
  title: "a language Mollie does not offer is left to the payer's browser, and a regional one keeps its region only when Mollie lists it (en-GB), otherwise it gets the region Mollie offers (pt-BR is pt_PT)",
  entryPoint: "`CreateCheckoutSession` with `ja`, `auto`, `en-GB` and `pt-BR` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const locales: [string, string | null][] = [["ja", null], ["auto", null], ["en-GB", "en_GB"], ["pt-BR", "pt_PT"]];
      for (const [locale, sent] of locales) {
        const created = await call(session, `CreateCheckoutSession in ${locale}`, "CreateCheckoutSession", [
          { amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), successUrl: RETURN_URL, cancelUrl: RETURN_URL, locale },
          fresh("key"),
          null,
        ]);
        const request = callsTo(session, "POST", "/v2/payments").at(-1);
        context.expect(created.folder, [answered(created), same(`${locale} reaches Mollie as ${sent ?? "no locale"}`, pick(request?.body, "locale") ?? null, sent)]);
      }
    });
  },
};

export const checkoutJourneys = {
  "hosted-session": hostedSession,
  "session-locales": sessionLocales,
};
