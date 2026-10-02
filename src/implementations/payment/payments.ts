import { SUBSCRIPTION_METADATA_KEY } from "@antelopejs/interface-subscriptions";
import {
  type Amount,
  InvalidPaymentStateError,
  type Payment,
  type PaymentRequest,
} from "@antelopejs/interface-payment";

import { IsMollieId } from "../../mollie/ids";
import { DefinedFields } from "../../mollie/fields";
import { WriteMetadata } from "../../mollie/metadata";
import { ToPayment, ToPaymentStatus } from "./mapping";
import { type Account, GetAccount } from "../../accounts";
import { type Entity, NotFound, Translating } from "./errors";
import { FromMollieAmount, ToMollieAmount } from "../../mollie/amounts";
import { SubscriptionOfPayment } from "../shared/subscription-of-payment";
import type { MolliePayment, MollieSequenceType } from "../../mollie/types";
import {
  AssertCapturable,
  AssertConsistent,
  type Instrument,
  MANUAL_CAPTURE_METHODS,
  ResolveInstrument,
} from "./instruments";

const PAYMENT_ENTITY = "payment";
const MANUAL = "manual";

function sequenceType(
  request: PaymentRequest,
  instrument: Instrument,
): MollieSequenceType {
  if (instrument.kind === "mandate") return "recurring";
  return request.savePaymentMethod ? "first" : "oneoff";
}

function PaymentBody(
  request: PaymentRequest,
  instrument: Instrument,
  account: Account,
): Record<string, unknown> {
  const isRecurring = instrument.kind === "mandate";
  return {
    amount: ToMollieAmount(request.amount),
    description: request.description ?? request.reference,
    sequenceType: sequenceType(request, instrument),
    metadata: WriteMetadata({ reference: request.reference }, request.metadata),
    ...instrument.fields,
    ...DefinedFields({
      method:
        instrument.kind === "hosted" && request.authorizeOnly
          ? MANUAL_CAPTURE_METHODS
          : undefined,
      customerId: isRecurring ? undefined : request.customer,
      redirectUrl: isRecurring ? undefined : request.returnUrl,
      captureMode: request.authorizeOnly ? MANUAL : undefined,
      webhookUrl: account.webhookUrl,
    }),
  };
}

export async function MarkSubscriptionCharge(
  account: Account,
  mollie: MolliePayment,
  payment = ToPayment(mollie),
): Promise<Payment> {
  const subscription = await SubscriptionOfPayment(account, mollie);
  if (!subscription) return payment;
  return {
    ...payment,
    metadata: {
      ...payment.metadata,
      [SUBSCRIPTION_METADATA_KEY]: subscription,
    },
  };
}

export async function ReadPayment(
  account: Account,
  id: string,
  entity: Entity = PAYMENT_ENTITY,
): Promise<MolliePayment> {
  if (!IsMollieId("payment", id)) throw NotFound(id, entity);
  return Translating(id, entity, () =>
    account.client.request<MolliePayment>({
      method: "GET",
      path: `/payments/${id}`,
    }),
  );
}

export async function CreatePayment(
  request: PaymentRequest,
  idempotencyKey: string,
  provider?: string,
): Promise<Payment> {
  const instrument = ResolveInstrument(request.paymentMethod);
  AssertConsistent(request, instrument);
  const account = GetAccount(provider);
  if (request.authorizeOnly) {
    await AssertCapturable(account, instrument, request.paymentMethod ?? "");
  }
  return Translating(request.paymentMethod ?? "", PAYMENT_ENTITY, async () =>
    ToPayment(
      await account.client.request<MolliePayment>({
        method: "POST",
        path: "/payments",
        body: PaymentBody(request, instrument, account),
        idempotencyKey,
      }),
    ),
  );
}

export async function GetPayment(
  id: string,
  provider?: string,
): Promise<Payment> {
  const account = GetAccount(provider);
  const payment = await ReadPayment(account, id);
  return Translating(id, PAYMENT_ENTITY, () =>
    MarkSubscriptionCharge(account, payment),
  );
}

function refuse(payment: MolliePayment, action: string): never {
  const status = ToPaymentStatus(payment);
  throw new InvalidPaymentStateError(
    `Payment ${payment.id} is ${status} (${payment.status} at Mollie) and cannot be ${action}`,
    status,
  );
}

function assertCapturableAmount(payment: MolliePayment, amount?: Amount): void {
  if (!amount) return;
  const authorized = FromMollieAmount(payment.amount);
  if (amount.currency.toUpperCase() !== authorized.currency) {
    refuse(payment, `captured in ${amount.currency}`);
  }
  if (amount.value > authorized.value) {
    refuse(payment, `captured for more than the ${authorized.value} held`);
  }
}

export async function CapturePayment(
  id: string,
  idempotencyKey: string,
  amount?: Amount,
  provider?: string,
): Promise<Payment> {
  const account = GetAccount(provider);
  const payment = await ReadPayment(account, id);
  if (payment.status !== "authorized") refuse(payment, "captured");
  assertCapturableAmount(payment, amount);
  return Translating(id, PAYMENT_ENTITY, async () => {
    await account.client.request({
      method: "POST",
      path: `/payments/${id}/captures`,
      body: amount ? { amount: ToMollieAmount(amount) } : {},
      idempotencyKey,
    });
    return ToPayment(await ReadPayment(account, id));
  });
}

type Cancellation = (
  account: Account,
  payment: MolliePayment,
  idempotencyKey: string,
) => Promise<unknown>;

const CANCELLATIONS: Partial<Record<MolliePayment["status"], Cancellation>> = {
  authorized: (account, payment, idempotencyKey) =>
    account.client.request({
      method: "POST",
      path: `/payments/${payment.id}/release-authorization`,
      body: {},
      idempotencyKey,
    }),
  canceled: async () => undefined,
  expired: async () => undefined,
  open: (account, payment) => cancelOpen(account, payment),
  pending: (account, payment) => cancelOpen(account, payment),
};

async function cancelOpen(
  account: Account,
  payment: MolliePayment,
): Promise<unknown> {
  if (!payment.isCancelable) refuse(payment, "canceled any more");
  return account.client.request({
    method: "DELETE",
    path: `/payments/${payment.id}`,
  });
}

export async function CancelPayment(
  id: string,
  idempotencyKey: string,
  provider?: string,
): Promise<Payment> {
  const account = GetAccount(provider);
  const payment = await ReadPayment(account, id);
  const cancel = CANCELLATIONS[payment.status];
  if (!cancel) refuse(payment, "canceled");
  return Translating(id, PAYMENT_ENTITY, async () => {
    await cancel(account, payment, idempotencyKey);
    return ToPayment(await ReadPayment(account, id));
  });
}
