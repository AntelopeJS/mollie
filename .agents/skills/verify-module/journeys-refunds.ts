import type { Journey } from "@antelopejs/tooling-configs/verify";

import { answered, call, callsTo, fresh, paidPayment, paymentAtProvider, pick, same, text, thrown, withSession } from "./session.ts";

const refundFlow: Journey = {
  title: "a partial refund, then a refund with no amount that takes what is left, are recorded at Mollie and read back; a third refund is refused",
  entryPoint: "`RefundPayment`, `GetRefund` and `GetPayment` through core on a paid payment",
  async run(context) {
    await withSession(context, async (session) => {
      const id = await paidPayment(session, "paid payment");
      const partial = await call(session, "RefundPayment 5.00", "RefundPayment", [{ payment: id, amount: { value: 500, currency: "EUR" } }, fresh("refund"), null]);
      context.expect(partial.folder, [
        answered(partial),
        same("the refund is for 5.00 on the payment", [pick(partial.value, "amount", "value"), pick(partial.value, "payment")], [500, id]),
        same("Mollie received a refund of 5.00", pick(callsTo(session, "POST", `/v2/payments/${id}/refunds`)[0]?.body, "amount", "value"), "5.00"),
      ], { critical: true });
      const rest = await call(session, "RefundPayment of what is left", "RefundPayment", [{ payment: id, reason: "fraudulent", metadata: { ticket: "42" } }, fresh("refund"), null]);
      context.expect(rest.folder, [
        answered(rest),
        same("the refund takes the remaining 20.00", pick(rest.value, "amount", "value"), 2000),
        same("the caller's metadata comes back without the module's own bookkeeping", pick(rest.value, "metadata"), { ticket: "42" }),
      ]);
      const read = await call(session, "GetRefund", "GetRefund", [text(pick(rest.value, "id")), null]);
      const payment = await call(session, "GetPayment", "GetPayment", [id, null]);
      context.expect(payment.folder, [
        same("the refund reads back on its payment", pick(read.value, "payment"), id),
        same("the payment reports 25.00 refunded", pick(payment.value, "amountRefunded", "value"), 2500),
        same("Mollie itself reports 25.00 refunded", pick(await paymentAtProvider(session, id), "amountRefunded", "value"), "25.00"),
      ]);
      const third = await call(session, "RefundPayment with nothing left", "RefundPayment", [{ payment: id }, fresh("refund"), null]);
      context.expect(third.folder, [same("nothing is left to refund", pick(thrown(third), 0), "InvalidPaymentStateError")]);
    });
  },
};

const refundReplay: Journey = {
  title: "replaying a refund with its idempotency key returns the original refund and refunds once, even when the payment is fully refunded",
  entryPoint: "`RefundPayment` twice with one key through core",
  async run(context) {
    await withSession(context, async (session) => {
      const id = await paidPayment(session, "paid payment");
      const key = fresh("refund");
      const first = await call(session, "RefundPayment", "RefundPayment", [{ payment: id }, key, null]);
      const replay = await call(session, "RefundPayment replayed", "RefundPayment", [{ payment: id }, key, null]);
      const payment = await call(session, "GetPayment", "GetPayment", [id, null]);
      context.expect(payment.folder, [
        answered(first),
        answered(replay),
        same("the replay returns the first refund", pick(replay.value, "id"), pick(first.value, "id")),
        same("the payment is refunded once", pick(payment.value, "amountRefunded", "value"), 2500),
      ]);
    });
  },
};

export const refundJourneys = {
  "refund-flow": refundFlow,
  "refund-replay": refundReplay,
};
