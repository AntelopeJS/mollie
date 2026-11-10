import type { Journey } from "@antelopejs/tooling-configs/verify";

import { answered, call, callsTo, fresh, paidPayment, paymentAtProvider, pick, same, text, thrown, withSession, wire, type Json, type Session } from "./session.ts";

/** The amounts of the refunds Mollie holds on a payment, smallest first, read with the account's key and not through the module. */
async function refundsAtProvider(session: Session, id: string): Promise<Json> {
  const refunds = pick((await wire(session, "GET", `/v2/payments/${id}/refunds`)).json, "_embedded", "refunds");
  if (!Array.isArray(refunds)) return null;
  return refunds.map((refund) => text(pick(refund, "amount", "value"))).sort((left, right) => Number(left) - Number(right));
}

const refundFlow: Journey = {
  title: "a partial refund, then a refund with no amount that takes what is left, are recorded at Mollie and read back; a refund of one cent more than remains is refused, and so is a third",
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
      const over = await call(session, "RefundPayment one cent over what is left", "RefundPayment", [{ payment: id, amount: { value: 2001, currency: "EUR" } }, fresh("refund"), null]);
      context.expect(over.folder, [
        same("more than remains is an InvalidPaymentStateError", pick(thrown(over), 0), "InvalidPaymentStateError"),
        same("no second refund request went out", callsTo(session, "POST", `/v2/payments/${id}/refunds`).length, 1),
      ]);
      const rest = await call(session, "RefundPayment of what is left", "RefundPayment", [{ payment: id, reason: "fraudulent", metadata: { ticket: "42" } }, fresh("refund"), null]);
      context.expect(rest.folder, [
        answered(rest),
        same("the refund takes the remaining 20.00", pick(rest.value, "amount", "value"), 2000),
        same("the caller's metadata comes back without the module's own bookkeeping", pick(rest.value, "metadata"), { ticket: "42" }),
        same("the reason reaches Mollie in the refund's description", text(pick(callsTo(session, "POST", `/v2/payments/${id}/refunds`)[1]?.body, "description")).includes("fraudulent"), true),
      ]);
      const read = await call(session, "GetRefund", "GetRefund", [text(pick(rest.value, "id")), null]);
      context.expect(read.folder, [
        same("the refund reads back on its payment", [pick(read.value, "payment"), pick(read.value, "amount", "value")], [id, 2000]),
        same("Mollie holds the two refunds, 5.00 and 20.00, and nothing left to refund", [await refundsAtProvider(session, id), pick(await paymentAtProvider(session, id), "amountRemaining", "value")], [["5.00", "20.00"], "0.00"]),
      ]);
      const third = await call(session, "RefundPayment with nothing left", "RefundPayment", [{ payment: id }, fresh("refund"), null]);
      context.expect(third.folder, [same("nothing is left to refund", pick(thrown(third), 0), "InvalidPaymentStateError")]);
    });
  },
};

const refundSettled: Journey = {
  title: "once Mollie settles the refunds of a payment, the payment reports the refunded total, as Mollie does",
  entryPoint: "`RefundPayment` in part, then of what is left, then `GetPayment`, through core on a paid payment",
  async run(context) {
    await withSession(
      context,
      async (session) => {
        const id = await paidPayment(session, "paid payment");
        const partial = await call(session, "RefundPayment 5.00", "RefundPayment", [{ payment: id, amount: { value: 500, currency: "EUR" } }, fresh("refund"), null]);
        const rest = await call(session, "RefundPayment of what is left", "RefundPayment", [{ payment: id }, fresh("refund"), null]);
        const payment = await call(session, "GetPayment", "GetPayment", [id, null]);
        context.expect(payment.folder, [
          answered(partial),
          answered(rest),
          same("the payment reports 25.00 refunded", pick(payment.value, "amountRefunded", "value"), 2500),
          same("Mollie itself reports 25.00 refunded", pick(await paymentAtProvider(session, id), "amountRefunded", "value"), "25.00"),
        ]);
      },
      { standIn: "refund-not-counted" },
    );
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
      context.expect(replay.folder, [
        answered(first),
        answered(replay),
        same("the replay returns the first refund", pick(replay.value, "id"), pick(first.value, "id")),
        same("Mollie holds one refund of the whole 25.00", await refundsAtProvider(session, id), ["25.00"]),
      ]);
    });
  },
};

export const refundJourneys = {
  "refund-flow": refundFlow,
  "refund-settled": refundSettled,
  "refund-replay": refundReplay,
};
