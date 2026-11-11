import { IsText } from "../../mollie/guards";
import { MollieApiError } from "../../mollie/errors";
import { setTimeout as delay } from "node:timers/promises";
import { IsMollieCapture, IsMolliePayment } from "../../mollie/resources";
import { SUBSCRIPTION_METADATA_KEY } from "@antelopejs/interface-subscriptions";
import {
  type Amount,
  InvalidPaymentStateError,
  type Payment,
  type PaymentRequest,
} from "@antelopejs/interface-payment";

import { IsMollieId } from "../../mollie/ids";
import { DefinedFields } from "../../mollie/fields";
import { ToPayment, ToPaymentStatus } from "./mapping";
import { type Account, GetAccount } from "../../accounts";
import {
  type Entity,
  InTurnOrder,
  NotFound,
  Translating,
  TranslatingNamed,
} from "./errors";
import { type OwnFields, ReadOwn, WriteMetadata } from "../../mollie/metadata";
import { FromMollieAmount, ToMollieAmount } from "../../mollie/amounts";
import { SubscriptionOfPayment } from "../shared/subscription-of-payment";
import type {
  MollieCapture,
  MolliePayment,
  MollieSequenceType,
} from "../../mollie/types";
import {
  AssertCapturable,
  AssertConsistent,
  type Instrument,
  MANUAL_CAPTURE_METHODS,
  ResolveInstrument,
} from "./instruments";

const PAYMENT_ENTITY = "payment";
const MANUAL = "manual";
const CAPTURE_PAGE = "?limit=250";
const SETTLE_POLL_MS = 250;
const UNPROCESSABLE = 422;

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
) {
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

export function MarkSubscriptionCharge(
  payment: Payment,
  subscription: string | undefined,
): Payment {
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
    account.client.request(
      {
        method: "GET",
        path: `/payments/${id}`,
      },
      IsMolliePayment,
    ),
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
  const named =
    instrument.kind === "mandate"
      ? {
          customer: instrument.customerId,
          paymentMethod: request.paymentMethod,
        }
      : { customer: request.customer };
  return TranslatingNamed(named, async () =>
    ToPayment(
      await account.client.request(
        {
          method: "POST",
          path: "/payments",
          body: PaymentBody(request, instrument, account),
          idempotencyKey,
        },
        IsMolliePayment,
      ),
    ),
  );
}

export async function GetPayment(
  id: string,
  provider?: string,
): Promise<Payment> {
  const account = GetAccount(provider);
  const payment = await ReadPayment(account, id);
  return Translating(id, PAYMENT_ENTITY, async () => {
    const [capture] =
      payment.status === "authorized" ? await readCaptures(account, id) : [];
    return MarkSubscriptionCharge(
      ToPayment(payment, capture),
      (await SubscriptionOfPayment(account, payment))?.id,
    );
  });
}

function refuse(
  payment: MolliePayment,
  action: string,
  capture?: MollieCapture,
): never {
  const status = ToPaymentStatus(payment, capture);
  const atMollie = capture
    ? `${payment.status} at Mollie, with capture ${capture.id} ${capture.status}`
    : `${payment.status} at Mollie`;
  throw new InvalidPaymentStateError(
    `Payment ${payment.id} is ${status} (${atMollie}) and cannot be ${action}`,
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

interface OwnCapture {
  key: string;
}

const OWN_CAPTURE: OwnFields<OwnCapture> = { key: IsText };

interface Hold {
  payment: MolliePayment;
  captures: MollieCapture[];
}

function readCaptures(account: Account, id: string): Promise<MollieCapture[]> {
  return account.client.list(
    `/payments/${id}/captures${CAPTURE_PAGE}`,
    "captures",
    IsMollieCapture,
  );
}

async function readHold(account: Account, id: string): Promise<Hold> {
  const [payment, captures] = await InTurnOrder(
    ReadPayment(account, id),
    readCaptures(account, id),
  );
  return { payment, captures };
}

/**
 * The capture made earlier under this key, or `undefined` when the payment can
 * take one. Mollie takes one capture per authorization, so any other capture,
 * whatever its status, refuses the call.
 */
function earlierCapture(
  { payment, captures }: Hold,
  idempotencyKey: string,
): MollieCapture | undefined {
  const own = captures.find(
    (capture) => ReadOwn(capture.metadata, OWN_CAPTURE)?.key === idempotencyKey,
  );
  if (own) return own;
  const [other] = captures;
  if (payment.status !== "authorized" || other) {
    refuse(payment, "captured", other);
  }
  return undefined;
}

/**
 * Mollie answers 422 to a capture of a payment that has one already, as it
 * does for a suspended account. The payment is read again: a capture made
 * meanwhile decides the call, and otherwise the 422 stands.
 */
async function requestCapture(
  account: Account,
  id: string,
  idempotencyKey: string,
  amount?: Amount,
): Promise<MollieCapture> {
  try {
    return await account.client.request(
      {
        method: "POST",
        path: `/payments/${id}/captures`,
        body: {
          metadata: WriteMetadata({ key: idempotencyKey }),
          ...DefinedFields({
            amount: amount ? ToMollieAmount(amount) : undefined,
          }),
        },
        idempotencyKey,
      },
      IsMollieCapture,
    );
  } catch (error) {
    if (!(error instanceof MollieApiError) || error.status !== UNPROCESSABLE) {
      throw error;
    }
    const own = earlierCapture(await readHold(account, id), idempotencyKey);
    if (!own) throw error;
    return own;
  }
}

/**
 * Mollie applies a capture to the payment after it answers. The payment is
 * read until it leaves `authorized` or the account's settle budget runs out;
 * in the second case it is returned `pending`, with the amount being captured.
 */
async function followCapture(
  account: Account,
  payment: MolliePayment,
  capture: MollieCapture,
): Promise<Payment> {
  const deadline = Date.now() + account.settleTimeoutMs;
  let current = payment;
  while (current.status === "authorized" && Date.now() < deadline) {
    await delay(SETTLE_POLL_MS);
    current = await ReadPayment(account, payment.id);
  }
  return ToPayment(current, capture);
}

export async function CapturePayment(
  id: string,
  idempotencyKey: string,
  amount?: Amount,
  provider?: string,
): Promise<Payment> {
  const account = GetAccount(provider);
  if (!IsMollieId("payment", id)) throw NotFound(id, PAYMENT_ENTITY);
  return Translating(id, PAYMENT_ENTITY, async () => {
    const hold = await readHold(account, id);
    const earlier = earlierCapture(hold, idempotencyKey);
    if (earlier) return followCapture(account, hold.payment, earlier);
    assertCapturableAmount(hold.payment, amount);
    const capture = await requestCapture(account, id, idempotencyKey, amount);
    return followCapture(account, hold.payment, capture);
  });
}

type Cancellation = (
  account: Account,
  payment: MolliePayment,
  idempotencyKey: string,
) => Promise<void>;

const CANCELLATIONS: Partial<Record<MolliePayment["status"], Cancellation>> = {
  authorized: (account, payment, idempotencyKey) =>
    account.client.execute({
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
): Promise<void> {
  if (!payment.isCancelable) refuse(payment, "canceled any more");
  return account.client.execute({
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
