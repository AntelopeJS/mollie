import { IsMollieRefund } from "../../mollie/resources";
import {
  type Amount,
  InvalidPaymentStateError,
  type Refund,
  type RefundRequest,
} from "@antelopejs/interface-payment";

import { ListRefunds, ReadPayment } from "./payments";
import { GetAccount } from "../../accounts";
import type { Account } from "../../accounts";
import { IsMollieId, ParseRefundId } from "../../mollie/ids";
import { InTurnOrder, NotFound, Translating } from "./errors";
import { DefinedFields } from "../../mollie/fields";
import { ToPaymentStatus, ToRefund } from "./mapping";
import { IsText } from "../../mollie/guards";
import { type OwnFields, ReadOwn, WriteMetadata } from "../../mollie/metadata";
import type { MolliePayment, MollieRefund } from "../../mollie/types";
import { FromMollieAmount, ToMollieAmount } from "../../mollie/amounts";

const REFUND_ENTITY = "refund";

interface OwnRefund {
  key: string;
}

const OWN_REFUND: OwnFields<OwnRefund> = { key: IsText };

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
  paymentId: string,
  idempotencyKey: string,
): Promise<MollieRefund | undefined> {
  const refunds = await ListRefunds(account, paymentId);
  return refunds.find(
    (refund) => ReadOwn(refund.metadata, OWN_REFUND)?.key === idempotencyKey,
  );
}

export async function RefundPayment(
  request: RefundRequest,
  idempotencyKey: string,
  provider?: string,
): Promise<Refund> {
  const account = GetAccount(provider);
  if (!IsMollieId("payment", request.payment)) {
    throw NotFound(request.payment, "payment");
  }
  const [payment, earlier] = await InTurnOrder(
    ReadPayment(account, request.payment),
    Translating(request.payment, "payment", () =>
      earlierRefund(account, request.payment, idempotencyKey),
    ),
  );
  if (earlier) return ToRefund(earlier);
  const amount = refundableAmount(payment, request.amount);
  return Translating(request.payment, "payment", async () =>
    ToRefund(
      await account.client.request(
        {
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
        },
        IsMollieRefund,
      ),
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
      await account.client.request(
        {
          method: "GET",
          path: `/payments/${parsed.parent}/refunds/${parsed.child}`,
        },
        IsMollieRefund,
      ),
    ),
  );
}
