import {
  type Amount,
  InvalidPaymentStateError,
  type Refund,
  type RefundRequest,
} from "@antelopejs/interface-payment";

import { ReadPayment } from "./payments";
import { GetAccount } from "../../accounts";
import type { Account } from "../../accounts";
import { ParseRefundId } from "../../mollie/ids";
import { NotFound, Translating } from "./errors";
import { DefinedFields } from "../../mollie/fields";
import { ToPaymentStatus, ToRefund } from "./mapping";
import { ReadOwn, WriteMetadata } from "../../mollie/metadata";
import type { MolliePayment, MollieRefund } from "../../mollie/types";
import { FromMollieAmount, ToMollieAmount } from "../../mollie/amounts";

const REFUND_ENTITY = "refund";
const REFUND_PAGE = "?limit=250";

interface OwnRefund {
  key: string;
}

function refusal(payment: MolliePayment, reason: string): Error {
  return new InvalidPaymentStateError(
    `Payment ${payment.id} cannot be refunded: ${reason}`,
    ToPaymentStatus(payment),
  );
}

function refundableAmount(payment: MolliePayment, requested?: Amount): Amount {
  if (payment.status !== "paid") {
    throw refusal(payment, `it is ${payment.status} at Mollie, not paid`);
  }
  const remaining = payment.amountRemaining
    ? FromMollieAmount(payment.amountRemaining)
    : FromMollieAmount(payment.amount);
  const amount = requested ?? remaining;
  if (amount.currency.toUpperCase() !== remaining.currency) {
    throw refusal(payment, `it was taken in ${remaining.currency}`);
  }
  if (amount.value <= 0 || amount.value > remaining.value) {
    throw refusal(
      payment,
      `${amount.value} asked, ${remaining.value} left to refund`,
    );
  }
  return amount;
}

async function earlierRefund(
  account: Account,
  payment: MolliePayment,
  idempotencyKey: string,
): Promise<MollieRefund | undefined> {
  const refunds = await account.client.list<MollieRefund>(
    `/payments/${payment.id}/refunds${REFUND_PAGE}`,
    "refunds",
  );
  return refunds.find(
    (refund) => ReadOwn<OwnRefund>(refund.metadata)?.key === idempotencyKey,
  );
}

export async function RefundPayment(
  request: RefundRequest,
  idempotencyKey: string,
  provider?: string,
): Promise<Refund> {
  const account = GetAccount(provider);
  const payment = await ReadPayment(account, request.payment);
  const earlier = await Translating(request.payment, "payment", () =>
    earlierRefund(account, payment, idempotencyKey),
  );
  if (earlier) return ToRefund(earlier);
  const amount = refundableAmount(payment, request.amount);
  return Translating(request.payment, "payment", async () =>
    ToRefund(
      await account.client.request<MollieRefund>({
        method: "POST",
        path: `/payments/${payment.id}/refunds`,
        body: {
          amount: ToMollieAmount(amount),
          description: request.reason
            ? `Refund (${request.reason}) for ${payment.description}`
            : `Refund for ${payment.description}`,
          metadata: WriteMetadata(
            {
              key: idempotencyKey,
              ...DefinedFields({ reason: request.reason }),
            },
            request.metadata,
          ),
        },
        idempotencyKey,
      }),
    ),
  );
}

export async function GetRefund(
  id: string,
  provider?: string,
): Promise<Refund> {
  const parsed = ParseRefundId(id);
  if (!parsed) throw NotFound(id, REFUND_ENTITY);
  const account = GetAccount(provider);
  return Translating(id, REFUND_ENTITY, async () =>
    ToRefund(
      await account.client.request<MollieRefund>({
        method: "GET",
        path: `/payments/${parsed.parent}/refunds/${parsed.child}`,
      }),
    ),
  );
}
