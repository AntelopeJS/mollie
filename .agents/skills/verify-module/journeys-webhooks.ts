import type { Journey } from "@antelopejs/tooling-configs/verify";

import { RETURN_URL, SECOND_ACCOUNT, answered, call, callsTo, fresh, settleDelivered, pick, same, settle, text, thrown, withSession } from "./session.ts";

function classic(body: string) {
  return { body: [...Buffer.from(body)], headers: { "content-type": "application/x-www-form-urlencoded" } };
}

const webhookReadsBack: Journey = {
  title: "a delivery that names a payment becomes the event of the payment's status as Mollie holds it, whatever else the body claims, and an expired payment is payment.canceled",
  entryPoint: "`VerifyWebhook` through core with classic `id=tr_…` deliveries, and the deliveries Mollie sends as the payments settle",
  async run(context) {
    await withSession(context, async (session) => {
      const created = await call(session, "CreatePayment", "CreatePayment", [{ amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      const id = text(pick(created.value, "id"));
      const open = await call(session, "VerifyWebhook of an open payment", "VerifyWebhook", [classic(`id=${id}`), null]);
      context.expect(open.folder, [answered(open), same("a payment that is still open raises nothing", open.value ?? null, null)]);
      const delivery = await settleDelivered(session, id, "paid");
      const lying = await call(session, "VerifyWebhook claiming failure", "VerifyWebhook", [classic(`id=${id}&status=failed`), null]);
      const again = await call(session, "VerifyWebhook again", "VerifyWebhook", [classic(`id=${id}`), null]);
      context.expect(again.folder, [
        delivery,
        answered(lying),
        same("the status comes from Mollie, never from the body", [pick(lying.value, "type"), pick(lying.value, "payment", "status")], ["payment.succeeded", "succeeded"]),
        same("the event is about the payment and its status", pick(lying.value, "id"), `${id}:paid`),
        same("every delivery of one state gets the same event id", pick(again.value, "id"), `${id}:paid`),
      ]);
      const failing = await call(session, "CreatePayment by card to fail", "CreatePayment", [{ amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), paymentMethod: "creditcard", returnUrl: RETURN_URL }, fresh("key"), null]);
      const failingId = text(pick(failing.value, "id"));
      await settle(session, failingId, "failed");
      const failed = await call(session, "VerifyWebhook of a failed payment", "VerifyWebhook", [classic(`id=${failingId}`), null]);
      context.expect(failed.folder, [same("a failed payment is payment.failed", pick(failed.value, "type"), "payment.failed")]);
      const lapsing = await call(session, "CreatePayment by card to expire", "CreatePayment", [{ amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), paymentMethod: "creditcard", returnUrl: RETURN_URL }, fresh("key"), null]);
      const lapsingId = text(pick(lapsing.value, "id"));
      await settle(session, lapsingId, "expired");
      const lapsed = await call(session, "VerifyWebhook of an expired payment", "VerifyWebhook", [classic(`id=${lapsingId}`), null]);
      context.expect(lapsed.folder, [
        same("an expired payment is payment.canceled, about the payment's Mollie status", [pick(lapsed.value, "type"), pick(lapsed.value, "id")], ["payment.canceled", `${lapsingId}:expired`]),
        same("the payment in the event reads canceled", pick(lapsed.value, "payment", "status"), "canceled"),
      ]);
    });
  },
};

const webhookRefused: Journey = {
  title: "a delivery that names no Mollie payment, or a payment Mollie does not have, is refused as unverifiable",
  entryPoint: "`VerifyWebhook` through core with forged deliveries",
  async run(context) {
    await withSession(context, async (session) => {
      const empty = await call(session, "VerifyWebhook without a payment", "VerifyWebhook", [classic("hello=world"), null]);
      const unknown = await call(session, "VerifyWebhook of an unknown payment", "VerifyWebhook", [classic("id=tr_nope123456"), null]);
      context.expect(unknown.folder, [
        same("a body that names no payment is refused", pick(thrown(empty), 0), "WebhookVerificationError"),
        same("a payment Mollie does not have is refused", pick(thrown(unknown), 0), "WebhookVerificationError"),
      ]);
    });
  },
};

const webhookOtherAccount: Journey = {
  title: "a delivery of another account's payment is refused as unverifiable, and the account that owns the payment verifies it",
  entryPoint: "`VerifyWebhook` through core with a payment of the second account, on each account",
  async run(context) {
    await withSession(
      context,
      async (session) => {
        const own = await call(session, "CreatePayment on the second account", "CreatePayment", [{ amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), SECOND_ACCOUNT]);
        const id = text(pick(own.value, "id"));
        const delivery = await settleDelivered(session, id, "paid", "second");
        const wrongAccount = await call(session, "VerifyWebhook on the default account", "VerifyWebhook", [classic(`id=${id}`), null]);
        const rightAccount = await call(session, "VerifyWebhook on the second account", "VerifyWebhook", [classic(`id=${id}`), SECOND_ACCOUNT]);
        context.expect(rightAccount.folder, [
          answered(own),
          delivery,
          same("another account's payment is refused on the default account", pick(thrown(wrongAccount), 0), "WebhookVerificationError"),
          same("the account that owns it verifies it", pick(rightAccount.value, "type"), "payment.succeeded"),
        ]);
      },
      { separateAccounts: true },
    );
  },
};

const webhookOutage: Journey = {
  title: "while Mollie answers 503 a call fails with a PaymentError carrying Mollie's message and VerifyWebhook rejects with it, not as a forged delivery, so Mollie delivers again; once Mollie is back the same calls succeed",
  entryPoint: "`CreatePayment` and `VerifyWebhook` through core while Mollie answers every request of the module with 503",
  async run(context) {
    await withSession(context, async (session) => {
      const request = { amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL };
      const paid = await call(session, "CreatePayment to pay", "CreatePayment", [request, fresh("key"), null]);
      const paidId = text(pick(paid.value, "id"));
      const delivery = await settleDelivered(session, paidId, "paid");
      const key = fresh("key");
      session.target.outage = 503;
      try {
        const create = await call(session, "CreatePayment during the outage", "CreatePayment", [request, key, null]);
        const verify = await call(session, "VerifyWebhook during the outage", "VerifyWebhook", [classic(`id=${paidId}`), null]);
        context.expect(verify.folder, [
          delivery,
          same("a call is a PaymentError with Mollie's message", [pick(thrown(create), 0), text(pick(thrown(create), 1)).includes("temporarily unavailable")], ["PaymentError", true]),
          same("the delivery is rejected as a PaymentError with Mollie's message, which Mollie answers by delivering again, not as a WebhookVerificationError", [pick(thrown(verify), 0), text(pick(thrown(verify), 1)).includes("temporarily unavailable")], ["PaymentError", true]),
        ]);
      } finally {
        session.target.outage = undefined;
      }
      const created = await call(session, "CreatePayment after the outage", "CreatePayment", [request, key, null]);
      const verified = await call(session, "VerifyWebhook after the outage", "VerifyWebhook", [classic(`id=${paidId}`), null]);
      context.expect(verified.folder, [
        answered(created),
        answered(verified),
        same("the same delivery is verified once Mollie is back", [pick(verified.value, "type"), pick(verified.value, "id")], ["payment.succeeded", `${paidId}:paid`]),
        same("the call that failed created exactly one payment once it was retried under its key", callsTo(session, "POST", "/v2/payments").filter((entry) => entry.idempotencyKey === key).length, 1),
      ]);
    });
  },
};

export const webhookJourneys = {
  "webhook-reads-back": webhookReadsBack,
  "webhook-refused": webhookRefused,
  "webhook-other-account": webhookOtherAccount,
  "webhook-outage": webhookOutage,
};
