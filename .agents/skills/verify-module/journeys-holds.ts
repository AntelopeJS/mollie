import type { Journey } from "@antelopejs/tooling-configs/verify";

import { RETURN_URL, answered, call, callsOf, callsTo, fresh, paymentAtProvider, pick, same, savedMethod, settle, text, thrown, withSession, wire, type Session } from "./session.ts";

const HELD = { value: 2500, currency: "EUR" };

/** An authorize-only payment the payer is sent to Mollie for, as the module creates it. */
function hostedHold(session: Session, name: string) {
  return call(session, name, "CreatePayment", [{ amount: HELD, reference: fresh("hold"), authorizeOnly: true, returnUrl: RETURN_URL }, fresh("key"), null]);
}

const holdCapture: Journey = {
  title: "an authorize-only payment waits on the payer as requires_action, held for manual capture at Mollie; once the payer authorizes it nothing is captured, and it captures in part and records the capture at Mollie",
  entryPoint: "`CreatePayment` with `authorizeOnly`, the payer authorizing at Mollie's checkout, then `GetPayment` and `CapturePayment` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const hosted = await hostedHold(session, "CreatePayment authorize only, hosted");
      const id = text(pick(hosted.value, "id"));
      context.expect(hosted.folder, [
        answered(hosted),
        same("a hosted hold waits on the payer, held for manual capture at Mollie", [pick(hosted.value, "status"), pick(await paymentAtProvider(session, id), "captureMode")], ["requires_action", "manual"]),
      ], { critical: true });
      await settle(session, id, "authorized");
      const authorized = await call(session, "GetPayment authorized", "GetPayment", [id, null]);
      context.expect(authorized.folder, [same("once the payer authorizes it nothing is captured yet", [pick(authorized.value, "status"), pick(authorized.value, "amountCaptured", "value")], ["authorized", 0])]);
      const key = fresh("capture");
      const captured = await call(session, "CapturePayment 10.00 of 25.00", "CapturePayment", [id, key, { value: 1000, currency: "EUR" }, null]);
      context.expect(captured.folder, [
        answered(captured),
        same("the payment is succeeded with 10.00 captured of 25.00", [pick(captured.value, "status"), pick(captured.value, "amountCaptured", "value"), pick(captured.value, "amount", "value")], ["succeeded", 1000, 2500]),
      ]);
      const sent = callsTo(session, "POST", `/v2/payments/${id}/captures`);
      context.expect(captured.folder, [
        same("Mollie received one capture of 10.00", [sent.length, pick(sent[0]?.body, "amount", "value")], [1, "10.00"]),
      ]);
      const replay = await call(session, "CapturePayment replayed", "CapturePayment", [id, key, { value: 1000, currency: "EUR" }, null]);
      const second = await call(session, "CapturePayment again under a new key", "CapturePayment", [id, fresh("capture"), { value: 1000, currency: "EUR" }, null]);
      context.expect(second.folder, [
        same("the same key returns the original capture", pick(replay.value, "amountCaptured", "value"), 1000),
        same("capturing again under a new key is refused as a state error", pick(thrown(second), 0), "InvalidPaymentStateError"),
      ]);
    });
  },
};

const holdSavedCard: Journey = {
  title: "an authorize-only payment on a saved card is pending until Mollie authorizes it, held for manual capture at Mollie, and reads authorized with nothing captured once Mollie does",
  entryPoint: "`CreatePayment` with `authorizeOnly` on a saved card off-session, then `GetPayment`, through core",
  async run(context) {
    await withSession(
      context,
      async (session) => {
        const saved = await savedMethod(session, "saved card");
        const created = await call(session, "CreatePayment authorize only", "CreatePayment", [{ amount: HELD, reference: fresh("hold"), paymentMethod: saved.method, offSession: true, authorizeOnly: true }, fresh("key"), null]);
        const id = text(pick(created.value, "id"));
        context.expect(created.folder, [
          answered(created),
          same("the hold is pending when created", pick(created.value, "status"), "pending"),
          same("Mollie holds it for manual capture", pick(await paymentAtProvider(session, id), "captureMode"), "manual"),
        ], { critical: true });
        await settle(session, id, "authorized");
        const authorized = await call(session, "GetPayment authorized", "GetPayment", [id, null]);
        context.expect(authorized.folder, [same("once Mollie authorizes it nothing is captured yet", [pick(authorized.value, "status"), pick(authorized.value, "amountCaptured", "value")], ["authorized", 0])]);
      },
      { standIn: "no-hold-on-saved-card" },
    );
  },
};

const holdRelease: Journey = {
  title: "cancelling an authorized payment releases the authorization at Mollie, and a settled payment cannot be cancelled",
  entryPoint: "`CancelPayment` through core on a payment the payer authorized and on a paid one",
  async run(context) {
    await withSession(context, async (session) => {
      const held = await hostedHold(session, "CreatePayment authorize only");
      const heldId = text(pick(held.value, "id"));
      await settle(session, heldId, "authorized");
      const released = await call(session, "CancelPayment of the authorization", "CancelPayment", [heldId, fresh("key"), null]);
      context.expect(released.folder, [
        answered(released),
        same("the released hold is canceled with nothing captured", [pick(released.value, "status"), pick(released.value, "amountCaptured", "value")], ["canceled", 0]),
        same("Mollie was asked to release the authorization", callsTo(session, "POST", `/v2/payments/${heldId}/release-authorization`).length, 1),
      ]);
      const paid = await call(session, "CreatePayment to pay", "CreatePayment", [{ amount: { value: 1050, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      await settle(session, text(pick(paid.value, "id")), "paid");
      const refused = await call(session, "CancelPayment of a paid payment", "CancelPayment", [text(pick(paid.value, "id")), fresh("key"), null]);
      context.expect(refused.folder, [same("a settled payment cannot be cancelled", pick(thrown(refused), 0), "InvalidPaymentStateError")]);
    });
  },
};

const cancelOpen: Journey = {
  title: "cancelling an open payment cancels it at Mollie, and cancelling a cancelled payment returns it again, whatever the idempotency key",
  entryPoint: "`CancelPayment` twice through core on an open payment",
  async run(context) {
    await withSession(
      context,
      async (session) => {
        const open = await call(session, "CreatePayment to cancel", "CreatePayment", [{ amount: { value: 1050, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
        const openId = text(pick(open.value, "id"));
        const canceled = await call(session, "CancelPayment of the open payment", "CancelPayment", [openId, fresh("key"), null]);
        const again = await call(session, "CancelPayment again", "CancelPayment", [openId, fresh("key"), null]);
        context.expect(again.folder, [
          same("an open payment cancels", pick(canceled.value, "status"), "canceled"),
          same("cancelling a cancelled payment returns it", pick(again.value, "status"), "canceled"),
          same("Mollie holds it as canceled", pick(await paymentAtProvider(session, openId), "status"), "canceled"),
        ]);
      },
      { standIn: "open-payment-not-cancelable" },
    );
  },
};

const holdRefused: Journey = {
  title: "an authorize-only payment on a method Mollie would capture at once is refused before any payment request reaches Mollie, and on a saved SEPA mandate only after reading the mandate's method",
  entryPoint: "`CreatePayment` with `authorizeOnly` on the iDEAL method and on a saved SEPA mandate, through core",
  async run(context) {
    await withSession(context, async (session) => {
      const refused = await call(session, "CreatePayment authorize only on iDEAL", "CreatePayment", [
        { amount: HELD, reference: fresh("hold"), paymentMethod: "ideal", authorizeOnly: true, returnUrl: RETURN_URL },
        fresh("key"),
        null,
      ]);
      context.expect(refused.folder, [
        same("the request is a PaymentError", pick(thrown(refused), 0), "PaymentError"),
        same("no request reached Mollie", callsOf(session).length, 0),
      ]);
      const customer = await call(session, "CreateCustomer for a SEPA mandate", "CreateCustomer", [{ email: `${fresh("sepa")}@merchant.invalid`, name: "SEPA Payer" }, fresh("key"), null]);
      const customerId = text(pick(customer.value, "id"));
      const mandate = await wire(session, "POST", `/v2/customers/${customerId}/mandates`, "primary", { method: "directdebit", consumerName: "SEPA Payer", consumerAccount: "NL55INGB0000000000" });
      const mandateId = text(pick(mandate.json, "id"));
      const onMandate = await call(session, "CreatePayment authorize only on a SEPA mandate", "CreatePayment", [
        { amount: HELD, reference: fresh("hold"), paymentMethod: `${customerId}:${mandateId}`, offSession: true, authorizeOnly: true },
        fresh("key"),
        null,
      ]);
      context.expect(onMandate.folder, [
        answered(customer),
        same("Mollie saved the SEPA mandate", mandate.status, 201),
        same("authorize-only on a SEPA mandate is a PaymentError naming the mandate's method", [pick(thrown(onMandate), 0), text(pick(thrown(onMandate), 1)).startsWith("Mollie cannot hold a directdebit payment")], ["PaymentError", true]),
        same("the module read the mandate from Mollie and sent no payment request", [callsTo(session, "GET", `/v2/customers/${customerId}/mandates/${mandateId}`).length, callsTo(session, "POST", "/v2/payments").length], [1, 0]),
      ]);
    });
  },
};

export const holdJourneys = {
  "hold-capture": holdCapture,
  "hold-saved-card": holdSavedCard,
  "hold-release": holdRelease,
  "cancel-open": cancelOpen,
  "hold-refused": holdRefused,
};
