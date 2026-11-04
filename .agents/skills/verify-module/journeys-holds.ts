import type { Journey } from "@antelopejs/tooling-configs/verify";

import { RETURN_URL, answered, call, callsTo, fresh, paymentAtProvider, pick, same, savedMethod, settle, text, thrown, withSession, wire, PRIMARY_KEY } from "./session.ts";

const holdCapture: Journey = {
  title: "an authorize-only payment is pending until Mollie authorizes it, then captures in part and records the capture at Mollie",
  entryPoint: "`CreatePayment` with `authorizeOnly`, `GetPayment` and `CapturePayment` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const created = await call(session, "CreatePayment authorize only", "CreatePayment", [
        { amount: { value: 2500, currency: "EUR" }, reference: fresh("hold"), paymentMethod: saved.method, offSession: true, authorizeOnly: true },
        fresh("key"),
        null,
      ]);
      const id = text(pick(created.value, "id"));
      context.expect(created.folder, [
        answered(created),
        same("the hold is pending when created", pick(created.value, "status"), "pending"),
        same("Mollie holds it for manual capture", pick(await paymentAtProvider(session, id), "captureMode"), "manual"),
      ], { critical: true });
      settle(session, id, "authorized");
      const authorized = await call(session, "GetPayment authorized", "GetPayment", [id, null]);
      context.expect(authorized.folder, [same("once Mollie authorizes it nothing is captured yet", [pick(authorized.value, "status"), pick(authorized.value, "amountCaptured", "value")], ["authorized", 0])]);
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

const holdRelease: Journey = {
  title: "cancelling an authorized payment releases it, cancelling an open one cancels it, and a cancelled payment cancels again as a replay",
  entryPoint: "`CancelPayment` through core on an authorized payment, an open one and a captured one",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const held = await call(session, "CreatePayment authorize only", "CreatePayment", [
        { amount: { value: 2500, currency: "EUR" }, reference: fresh("hold"), paymentMethod: saved.method, offSession: true, authorizeOnly: true },
        fresh("key"),
        null,
      ]);
      const heldId = text(pick(held.value, "id"));
      settle(session, heldId, "authorized");
      const released = await call(session, "CancelPayment of the authorization", "CancelPayment", [heldId, fresh("key"), null]);
      context.expect(released.folder, [
        answered(released),
        same("the released hold is canceled with nothing captured", [pick(released.value, "status"), pick(released.value, "amountCaptured", "value")], ["canceled", 0]),
        same("Mollie was asked to release the authorization", callsTo(session, "POST", `/v2/payments/${heldId}/release-authorization`).length, 1),
      ]);
      const open = await call(session, "CreatePayment to cancel", "CreatePayment", [{ amount: { value: 1050, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      const openId = text(pick(open.value, "id"));
      const canceled = await call(session, "CancelPayment of the open payment", "CancelPayment", [openId, fresh("key"), null]);
      const again = await call(session, "CancelPayment again", "CancelPayment", [openId, fresh("key"), null]);
      context.expect(again.folder, [
        same("an open payment cancels", pick(canceled.value, "status"), "canceled"),
        same("cancelling a cancelled payment returns it", pick(again.value, "status"), "canceled"),
        same("Mollie holds it as canceled", pick(await paymentAtProvider(session, openId), "status"), "canceled"),
      ]);
      const paid = await call(session, "CreatePayment to pay", "CreatePayment", [{ amount: { value: 1050, currency: "EUR" }, reference: fresh("order"), returnUrl: RETURN_URL }, fresh("key"), null]);
      settle(session, text(pick(paid.value, "id")), "paid");
      const refused = await call(session, "CancelPayment of a paid payment", "CancelPayment", [text(pick(paid.value, "id")), fresh("key"), null]);
      context.expect(refused.folder, [same("a settled payment cannot be cancelled", pick(thrown(refused), 0), "InvalidPaymentStateError")]);
    });
  },
};

const holdRefused: Journey = {
  title: "an authorize-only payment on a method Mollie would capture at once is refused before anything reaches Mollie",
  entryPoint: "`CreatePayment` with `authorizeOnly` and the iDEAL method through core",
  async run(context) {
    await withSession(context, async (session) => {
      const refused = await call(session, "CreatePayment authorize only on iDEAL", "CreatePayment", [
        { amount: { value: 2500, currency: "EUR" }, reference: fresh("hold"), paymentMethod: "ideal", authorizeOnly: true, returnUrl: RETURN_URL },
        fresh("key"),
        null,
      ]);
      const held = await wire(session.base, "GET", "/v2/payments", PRIMARY_KEY);
      context.expect(refused.folder, [
        same("the request is a PaymentError", pick(thrown(refused), 0), "PaymentError"),
        same("Mollie holds no payment", pick(held.json, "count"), 0),
      ]);
    });
  },
};

export const holdJourneys = {
  "hold-capture": holdCapture,
  "hold-release": holdRelease,
  "hold-refused": holdRefused,
};
