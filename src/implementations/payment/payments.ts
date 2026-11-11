import { IsText } from "../../mollie/guards";
import { MollieApiError } from "../../mollie/errors";
import { setTimeout as delay } from "node:timers/promises";
import { IsMollieCapture, IsMolliePayment } from "../../mollie/resources";
import { SUBSCRIPTION_METADATA_KEY } from "@antelopejs/interface-subscriptions";
import {
  type Amount,
  InvalidPaymentStateError,
  type Payment,
  PaymentError,
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
const CAPTURE_FAILED = "capture_failed";

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
    const capture =
      payment.status === "authorized"
        ? liveCapture(await readCaptures(account, id))
        : undefined;
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

function readCaptures(
  account: Account,
  id: string,
  signal?: AbortSignal,
): Promise<MollieCapture[]> {
  return account.client.list(
    `/payments/${id}/captures${CAPTURE_PAGE}`,
    "captures",
    IsMollieCapture,
    signal,
  );
}

/**
 * The capture that holds the payment: Mollie takes one capture per
 * authorization, and one that failed captured nothing.
 */
function liveCapture(captures: MollieCapture[]): MollieCapture | undefined {
  return captures.find((capture) => capture.status !== "failed");
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
 * take one. Mollie takes one capture per authorization, so any other capture
 * that has not failed refuses the call.
 */
function earlierCapture(
  { payment, captures }: Hold,
  idempotencyKey: string,
): MollieCapture | undefined {
  const own = captures.find(
    (capture) => ReadOwn(capture.metadata, OWN_CAPTURE)?.key === idempotencyKey,
  );
  if (own) return own;
  const other = liveCapture(captures);
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

interface Followed {
  payment: MolliePayment;
  capture: MollieCapture;
}

function settling({ payment, capture }: Followed): boolean {
  return payment.status === "authorized" && capture.status !== "failed";
}

/**
 * The payment and the capture read again, or `undefined` when the read fails
 * or takes longer than `timeoutMs`.
 */
async function reread(
  account: Account,
  { payment, capture }: Followed,
  timeoutMs: number,
): Promise<Followed | undefined> {
  try {
    const signal = AbortSignal.timeout(Math.max(timeoutMs, SETTLE_POLL_MS));
    const [current, captures] = await Promise.all([
      account.client.request(
        { method: "GET", path: `/payments/${payment.id}`, signal },
        IsMolliePayment,
      ),
      readCaptures(account, payment.id, signal),
    ]);
    const latest = captures.find(({ id }) => id === capture.id) ?? capture;
    return { payment: current, capture: latest };
  } catch {
    return undefined;
  }
}

function captureFailed({ payment, capture }: Followed): PaymentError {
  return new PaymentError(
    `Mollie failed capture ${capture.id} of payment ${payment.id} (${payment.status} at Mollie)`,
    CAPTURE_FAILED,
  );
}

/**
 * Mollie applies a capture to the payment after it answers. The payment and
 * its capture are read until the payment leaves `authorized`, the capture
 * fails, or the account's settle budget runs out. A read that fails, or that
 * the budget cuts short, ends the wait as the budget does: the payment is
 * returned `pending`, with the amount being captured. A failed capture
 * rejects with a `PaymentError`.
 */
async function followCapture(
  account: Account,
  followed: Followed,
): Promise<Payment> {
  const deadline = Date.now() + account.settleTimeoutMs;
  const timeLeft = () => deadline - Date.now();
  let current = followed;
  while (settling(current) && timeLeft() > 0) {
    await delay(Math.min(SETTLE_POLL_MS, timeLeft()));
    const next = await reread(account, current, timeLeft());
    if (!next) break;
    current = next;
  }
  if (current.capture.status === "failed") throw captureFailed(current);
  return ToPayment(current.payment, current.capture);
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
    if (earlier) {
      return followCapture(account, {
        payment: hold.payment,
        capture: earlier,
      });
    }
    assertCapturableAmount(hold.payment, amount);
    const capture = await requestCapture(account, id, idempotencyKey, amount);
    return followCapture(account, { payment: hold.payment, capture });
  });
}

type Cancellation = (
  account: Account,
  payment: MolliePayment,
  idempotencyKey: string,
) => Promise<void>;

const CANCELLATIONS: Partial<Record<MolliePayment["status"], Cancellation>> = {
  authorized: releaseHold,
  canceled: async () => undefined,
  expired: async () => undefined,
  open: (account, payment) => cancelOpen(account, payment),
  pending: (account, payment) => cancelOpen(account, payment),
};

/**
 * Mollie keeps a payment `authorized` until it applies the capture it has
 * accepted, so the payment's captures are read first: one in flight refuses
 * the release.
 */
async function releaseHold(
  account: Account,
  payment: MolliePayment,
  idempotencyKey: string,
): Promise<void> {
  const capture = liveCapture(await readCaptures(account, payment.id));
  if (capture) refuse(payment, "canceled", capture);
  return account.client.execute({
    method: "POST",
    path: `/payments/${payment.id}/release-authorization`,
    body: {},
    idempotencyKey,
  });
}

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
