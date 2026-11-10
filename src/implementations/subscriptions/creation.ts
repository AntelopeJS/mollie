import {
  IsMollieMandate,
  IsMolliePayment,
  IsMolliePaymentPage,
  IsMollieSubscription,
} from "../../mollie/resources";
import {
  InvalidSubscriptionRequestError,
  type Subscription,
  SubscriptionPaymentError,
  type SubscriptionRequest,
  ValidateSubscriptionRequest,
} from "@antelopejs/interface-subscriptions";

import { ToSubscription } from "./mapping";
import type { Account } from "../../accounts";
import { MollieApiError } from "../../mollie/errors";
import { LifecycleEvent, Raise } from "./events";
import { DefinedFields } from "../../mollie/fields";
import { ToMollieAmount } from "../../mollie/amounts";
import { IsChargeableOffSession, ToPayment } from "../payment/mapping";
import { ParsePaymentMethodId, SubscriptionId } from "../../mollie/ids";
import { SubscriptionAccount, TranslatingSubscription } from "./errors";
import { IsText } from "../../mollie/guards";
import {
  MergeOwn,
  type OwnFields,
  ReadOwn,
  WriteMetadata,
} from "../../mollie/metadata";
import type { MolliePayment, MollieSubscription } from "../../mollie/types";
import {
  AddPeriods,
  type CalendarDate,
  DateOf,
  FormatDate,
  NextDateFrom,
  type Period,
  ToMollieInterval,
} from "./calendar";
import {
  CompleteRecord,
  type OwnSubscription,
  ReadOwnSubscription,
  type StartKind,
  SubscriptionPath,
  type SubscriptionRecord,
} from "./records";

interface Schedule {
  start: StartKind;
  startDate: CalendarDate;
}

interface FirstCharge {
  subscription: string;
}

const FIRST_CHARGE: OwnFields<FirstCharge> = { subscription: IsText };

interface Creation {
  request: SubscriptionRequest;
  idempotencyKey: string;
  mandateId: string;
  period: Period;
}

const FIRST_PERIOD_KEY_SUFFIX = ":first-period";
const RECENT_PAYMENTS = { limit: "250" };
const SUBSCRIPTION_PAGE = "?limit=250";
const DEFAULT_DESCRIPTION = "Subscription";

function invalid(message: string): InvalidSubscriptionRequestError {
  return new InvalidSubscriptionRequestError(message);
}

function scheduleOf(request: SubscriptionRequest, period: Period): Schedule {
  if (request.trialEnd !== undefined) {
    return { start: "trial", startDate: NextDateFrom(request.trialEnd) };
  }
  if (request.billingAnchor !== undefined) {
    return { start: "anchor", startDate: NextDateFrom(request.billingAnchor) };
  }
  return {
    start: "charged",
    startDate: AddPeriods(DateOf(Date.now()), period, 1),
  };
}

export async function ChargeableMandate(
  account: Account,
  customer: string,
  paymentMethod: string,
): Promise<string> {
  const parsed = ParsePaymentMethodId(paymentMethod);
  if (!parsed) throw invalid(`No such payment method: ${paymentMethod}`);
  if (parsed.parent !== customer) {
    throw invalid(
      `Payment method ${paymentMethod} is not saved against ${customer}`,
    );
  }
  const mandate = await TranslatingSubscription(paymentMethod, async () => {
    try {
      return await account.client.request(
        {
          method: "GET",
          path: `/customers/${customer}/mandates/${parsed.child}`,
        },
        IsMollieMandate,
      );
    } catch (error) {
      if (error instanceof MollieApiError && error.isNotFound)
        throw invalid(`No such payment method: ${paymentMethod}`);
      throw error;
    }
  });
  if (!IsChargeableOffSession(mandate)) {
    throw invalid(
      `Payment method ${paymentMethod} cannot be charged off-session`,
    );
  }
  return mandate.id;
}

async function existingFor(
  account: Account,
  creation: Creation,
): Promise<MollieSubscription | undefined> {
  const listed = await account.client.list(
    `/customers/${creation.request.customer}/subscriptions${SUBSCRIPTION_PAGE}`,
    "subscriptions",
    IsMollieSubscription,
  );
  return listed.find(
    (subscription) =>
      ReadOwnSubscription(subscription)?.createKey === creation.idempotencyKey,
  );
}

function subscriptionBody(
  account: Account,
  creation: Creation,
  schedule: Schedule,
) {
  const { request, period } = creation;
  const own: OwnSubscription = {
    reference: request.reference,
    createKey: creation.idempotencyKey,
    interval: period.interval,
    intervalCount: period.count,
    start: schedule.start,
  };
  return {
    amount: ToMollieAmount(request.amount),
    interval: ToMollieInterval(period),
    startDate: FormatDate(schedule.startDate),
    description: `${request.description ?? DEFAULT_DESCRIPTION} (${request.reference})`,
    mandateId: creation.mandateId,
    metadata: WriteMetadata(own, request.metadata),
    ...DefinedFields({ webhookUrl: account.webhookUrl }),
  };
}

async function createAtMollie(
  account: Account,
  creation: Creation,
): Promise<MollieSubscription> {
  const existing = await existingFor(account, creation);
  if (existing) return existing;
  const schedule = scheduleOf(creation.request, creation.period);
  return account.client.request(
    {
      method: "POST",
      path: `/customers/${creation.request.customer}/subscriptions`,
      body: subscriptionBody(account, creation, schedule),
      idempotencyKey: creation.idempotencyKey,
    },
    IsMollieSubscription,
  );
}

async function updateOwn(
  account: Account,
  mollie: MollieSubscription,
  changes: Partial<OwnSubscription>,
): Promise<MollieSubscription> {
  return account.client.request(
    {
      method: "PATCH",
      path: SubscriptionPath(mollie.customerId, mollie.id),
      body: { metadata: MergeOwn(mollie.metadata, changes) },
    },
    IsMollieSubscription,
  );
}

async function readPayment(
  account: Account,
  id: string,
): Promise<MolliePayment> {
  return account.client.request(
    {
      method: "GET",
      path: `/payments/${id}`,
    },
    IsMolliePayment,
  );
}

function refusal(payment: MolliePayment): SubscriptionPaymentError {
  return new SubscriptionPaymentError(
    ToPayment(payment),
    payment.details?.failureReason ??
      payment.details?.bankReasonCode ??
      undefined,
  );
}

async function earlierCharge(
  account: Account,
  id: string,
  mollie: MollieSubscription,
): Promise<MolliePayment | undefined> {
  const page = await account.client.request(
    {
      method: "GET",
      path: `/customers/${mollie.customerId}/payments`,
      query: RECENT_PAYMENTS,
    },
    IsMolliePaymentPage,
  );
  return page._embedded?.payments?.find(
    (payment) => ReadOwn(payment.metadata, FIRST_CHARGE)?.subscription === id,
  );
}

async function chargeFirstPeriod(
  account: Account,
  id: string,
  mollie: MollieSubscription,
  creation: Creation,
): Promise<MolliePayment> {
  const earlier = await earlierCharge(account, id, mollie);
  if (earlier) return earlier;
  return account.client.request(
    {
      method: "POST",
      path: "/payments",
      body: {
        amount: mollie.amount,
        description: mollie.description,
        sequenceType: "recurring",
        customerId: mollie.customerId,
        mandateId: creation.mandateId,
        metadata: WriteMetadata({
          reference: creation.request.reference,
          subscription: id,
        }),
        ...DefinedFields({ webhookUrl: account.webhookUrl }),
      },
      idempotencyKey: `${creation.idempotencyKey}${FIRST_PERIOD_KEY_SUFFIX}`,
    },
    IsMolliePayment,
  );
}

/** Cancels a refused subscription at Mollie, unless Mollie already ended it. */
async function cancelRefused(
  account: Account,
  mollie: MollieSubscription,
): Promise<void> {
  if (mollie.status === "canceled" || mollie.status === "completed") return;
  await account.client.execute({
    method: "DELETE",
    path: SubscriptionPath(mollie.customerId, mollie.id),
  });
}

async function refuse(
  account: Account,
  mollie: MollieSubscription,
  payment: MolliePayment,
): Promise<never> {
  const refused = await updateOwn(account, mollie, { refused: payment.id });
  await cancelRefused(account, refused);
  throw refusal(payment);
}

function ownOf(mollie: MollieSubscription): OwnSubscription {
  const own = ReadOwnSubscription(mollie);
  if (!own) {
    throw new TypeError(
      `Subscription ${mollie.id} carries no metadata of this module`,
    );
  }
  return own;
}

async function settleFirstPeriod(
  account: Account,
  id: string,
  created: MollieSubscription,
  creation: Creation,
): Promise<SubscriptionRecord> {
  let mollie = created;
  let own = ownOf(mollie);
  if (own.refused) {
    await cancelRefused(account, mollie);
    throw refusal(await readPayment(account, own.refused));
  }
  if (own.start === "charged" && !own.firstPayment) {
    const payment = await chargeFirstPeriod(account, id, mollie, creation);
    if (payment.status === "failed") await refuse(account, mollie, payment);
    mollie = await updateOwn(account, mollie, { firstPayment: payment.id });
    own = ownOf(mollie);
  }
  return CompleteRecord(account, id, mollie, own);
}

async function create(
  account: Account,
  creation: Creation,
): Promise<Subscription> {
  const posted = await createAtMollie(account, creation);
  const id = SubscriptionId(creation.request.customer, posted.id);
  const current = await account.client.request(
    {
      method: "GET",
      path: SubscriptionPath(posted.customerId, posted.id),
    },
    IsMollieSubscription,
  );
  return ToSubscription(
    await settleFirstPeriod(account, id, current, creation),
  );
}

export async function CreateSubscription(
  request: SubscriptionRequest,
  idempotencyKey: string,
  provider?: string,
): Promise<Subscription> {
  ValidateSubscriptionRequest(request, Date.now());
  const period: Period = {
    interval: request.interval,
    count: request.intervalCount ?? 1,
  };
  ToMollieInterval(period);
  const account = SubscriptionAccount(provider);
  const mandateId = await ChargeableMandate(
    account,
    request.customer,
    request.paymentMethod,
  );
  const creation: Creation = { request, idempotencyKey, mandateId, period };
  const subscription = await TranslatingSubscription(request.customer, () =>
    create(account, creation),
  );
  await Raise(LifecycleEvent("subscription.created", subscription));
  return subscription;
}
