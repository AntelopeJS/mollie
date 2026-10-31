import type { Journey } from "@antelopejs/tooling-configs/verify";

import { RETURN_URL, SECOND_ACCOUNT, SECOND_KEY, answered, call, fresh, pause, pick, same, settle, text, thrown, withSession } from "./session.ts";

function classic(body: string) {
  return { body: [...Buffer.from(body)], headers: { "content-type": "application/x-www-form-urlencoded" } };
}

const webhookReadsBack: Journey = {
  title: "a delivery that names a payment becomes the event of the payment's status as Mollie holds it, whatever else the body claims, and an expired payment is payment.canceled",
  entryPoint: "`VerifyWebhook` through core with classic `id=tr_…` deliveries, and the stand-in's own webhook calls",
  async run(context) {
    await withSession(context, async (session) => {
      const created = await call(session, "CreatePayment", "CreatePayment", [{ amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      const id = text(pick(created.value, "id"));
      const open = await call(session, "VerifyWebhook of an open payment", "VerifyWebhook", [classic(`id=${id}`), null]);
      context.expect(open.folder, [answered(open), same("a payment that is still open raises nothing", open.value ?? null, null)]);
      settle(session, id, "paid");
      await pause(500);
      const lying = await call(session, "VerifyWebhook claiming failure", "VerifyWebhook", [classic(`id=${id}&status=failed`), null]);
      const again = await call(session, "VerifyWebhook again", "VerifyWebhook", [classic(`id=${id}`), null]);
      context.expect(again.folder, [
        answered(lying),
        same("the status comes from Mollie, never from the body", [pick(lying.value, "type"), pick(lying.value, "payment", "status")], ["payment.succeeded", "succeeded"]),
        same("the event is about the payment and its status", pick(lying.value, "id"), `${id}:paid`),
        same("every delivery of one state gets the same event id", pick(again.value, "id"), `${id}:paid`),
      ]);
      const failing = await call(session, "CreatePayment to fail", "CreatePayment", [{ amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      const failingId = text(pick(failing.value, "id"));
      settle(session, failingId, "failed");
      const failed = await call(session, "VerifyWebhook of a failed payment", "VerifyWebhook", [classic(`id=${failingId}`), null]);
      context.expect(failed.folder, [same("a failed payment is payment.failed", pick(failed.value, "type"), "payment.failed")]);
      const lapsing = await call(session, "CreatePayment to expire", "CreatePayment", [{ amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      const lapsingId = text(pick(lapsing.value, "id"));
      settle(session, lapsingId, "expired");
      const lapsed = await call(session, "VerifyWebhook of an expired payment", "VerifyWebhook", [classic(`id=${lapsingId}`), null]);
      context.expect(lapsed.folder, [
        same("an expired payment is payment.canceled, about the payment's Mollie status", [pick(lapsed.value, "type"), pick(lapsed.value, "id")], ["payment.canceled", `${lapsingId}:expired`]),
        same("the payment in the event reads canceled", pick(lapsed.value, "payment", "status"), "canceled"),
      ]);
    });
  },
};

const webhookRefused: Journey = {
  title: "a delivery that names no Mollie payment, a payment Mollie does not have, or a payment of another account is refused as unverifiable, and each account verifies its own",
  entryPoint: "`VerifyWebhook` through core with forged and foreign deliveries",
  async run(context) {
    await withSession(context, async (session) => {
      const empty = await call(session, "VerifyWebhook without a payment", "VerifyWebhook", [classic("hello=world"), null]);
      const unknown = await call(session, "VerifyWebhook of an unknown payment", "VerifyWebhook", [classic("id=tr_nope123456"), null]);
      context.expect(unknown.folder, [
        same("a body that names no payment is refused", pick(thrown(empty), 0), "WebhookVerificationError"),
        same("a payment Mollie does not have is refused", pick(thrown(unknown), 0), "WebhookVerificationError"),
      ]);
      const own = await call(session, "CreatePayment on the second account", "CreatePayment", [{ amount: { value: 2500, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), SECOND_ACCOUNT]);
      const id = text(pick(own.value, "id"));
      settle(session, id, "paid", SECOND_KEY);
      await pause(500);
      const wrongAccount = await call(session, "VerifyWebhook on the default account", "VerifyWebhook", [classic(`id=${id}`), null]);
      const rightAccount = await call(session, "VerifyWebhook on the second account", "VerifyWebhook", [classic(`id=${id}`), SECOND_ACCOUNT]);
      context.expect(rightAccount.folder, [
        same("another account's payment is refused on the default account", pick(thrown(wrongAccount), 0), "WebhookVerificationError"),
        same("the account that owns it verifies it", pick(rightAccount.value, "type"), "payment.succeeded"),
      ]);
    });
  },
};

export const webhookJourneys = {
  "webhook-reads-back": webhookReadsBack,
  "webhook-refused": webhookRefused,
};
