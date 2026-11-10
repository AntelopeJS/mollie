import type {
  Subscription,
  SubscriptionEndReason,
  SubscriptionStatus,
} from "@antelopejs/interface-subscriptions";

import { PaymentMethodId } from "../../mollie/ids";
import type { SubscriptionRecord } from "./records";
import { FromMollieAmount } from "../../mollie/amounts";
import { ReadCallerMetadata } from "../../mollie/metadata";
import type { MolliePaymentStatus } from "../../mollie/types";
import {
  AddPeriods,
  PeriodStartBefore,
  DateOf,
  ParseDate,
  type Period,
  StartOf,
} from "./calendar";

interface Bounds {
  start: number;
  end: number;
}

interface Ending {
  hasEnded: boolean;
  isEndingLater: boolean;
  endedAt?: number;
}

const ENDED_AT_MOLLIE = new Set(["canceled", "completed"]);
const UNPAID = new Set<MolliePaymentStatus>(["canceled", "expired", "failed"]);
const PERIOD_SEARCH_LIMIT = 10_000;

function periodOf(record: SubscriptionRecord): Period {
  return { interval: record.own.interval, count: record.own.intervalCount };
}

function firstPeriodStart(record: SubscriptionRecord): number {
  const createdAt = Date.parse(record.mollie.createdAt);
  return record.own.start === "charged"
    ? StartOf(DateOf(createdAt))
    : createdAt;
}

function steppedBounds(record: SubscriptionRecord, instant: number): Bounds {
  const anchor = ParseDate(record.mollie.startDate);
  const period = periodOf(record);
  let index = 0;
  while (
    index < PERIOD_SEARCH_LIMIT &&
    StartOf(AddPeriods(anchor, period, index + 1)) <= instant
  ) {
    index += 1;
  }
  return {
    start: StartOf(AddPeriods(anchor, period, index)),
    end: StartOf(AddPeriods(anchor, period, index + 1)),
  };
}

function endingBefore(record: SubscriptionRecord, end: number): Bounds {
  const anchor = ParseDate(record.mollie.startDate);
  if (end <= StartOf(anchor)) {
    return { start: firstPeriodStart(record), end };
  }
  return {
    start: StartOf(PeriodStartBefore(anchor, periodOf(record), DateOf(end))),
    end,
  };
}

function boundsAt(
  record: SubscriptionRecord,
  instant: number,
  ending: Ending,
): Bounds {
  const anchor = ParseDate(record.mollie.startDate);
  const firstEnd = StartOf(anchor);
  if (ending.isEndingLater && record.own.cancel?.endsAt) {
    return endingBefore(record, record.own.cancel.endsAt);
  }
  if (instant < firstEnd) {
    return { start: firstPeriodStart(record), end: firstEnd };
  }
  const next = record.mollie.nextPaymentDate;
  if (!ending.hasEnded && next) {
    return endingBefore(record, StartOf(ParseDate(next)));
  }
  return steppedBounds(record, instant);
}

function endingOf(record: SubscriptionRecord, now: number): Ending {
  const isMollieEnded = ENDED_AT_MOLLIE.has(record.mollie.status);
  const cancel = record.own.cancel;
  const endsAt = cancel?.timing === "period_end" ? cancel.endsAt : undefined;
  const isEndingLater =
    isMollieEnded && !record.earlyEnd && endsAt !== undefined && now < endsAt;
  if (!isMollieEnded || isEndingLater) {
    return { hasEnded: false, isEndingLater };
  }
  const canceledAt = record.mollie.canceledAt
    ? Date.parse(record.mollie.canceledAt)
    : now;
  return {
    hasEnded: true,
    isEndingLater: false,
    endedAt: record.earlyEnd?.endedAt ?? endsAt ?? canceledAt,
  };
}

function isUnpaid(record: SubscriptionRecord): boolean {
  return record.latest !== undefined && UNPAID.has(record.latest.status);
}

function statusOf(
  record: SubscriptionRecord,
  ending: Ending,
  now: number,
): SubscriptionStatus {
  if (ending.hasEnded) return "canceled";
  if (isUnpaid(record) || record.mollie.status === "suspended") {
    return "past_due";
  }
  const isInTrial =
    record.own.start === "trial" &&
    !record.latest &&
    now < StartOf(ParseDate(record.mollie.startDate));
  return isInTrial ? "trialing" : "active";
}

function endReasonOf(record: SubscriptionRecord): SubscriptionEndReason {
  const wasRequested = record.own.cancel !== undefined || record.earlyEnd;
  return !wasRequested && isUnpaid(record) ? "payment_failed" : "requested";
}

export function ToSubscription(
  record: SubscriptionRecord,
  now = Date.now(),
): Subscription {
  const { mollie, own } = record;
  const ending = endingOf(record, now);
  const bounds = boundsAt(record, ending.endedAt ?? now, ending);
  const metadata = ReadCallerMetadata(mollie.metadata);
  const result: Subscription = {
    id: record.id,
    reference: own.reference,
    customer: mollie.customerId,
    paymentMethod: mollie.mandateId
      ? PaymentMethodId(mollie.customerId, mollie.mandateId)
      : "",
    amount: FromMollieAmount(mollie.amount),
    interval: own.interval,
    intervalCount: own.intervalCount,
    status: statusOf(record, ending, now),
    currentPeriodStart: bounds.start,
    currentPeriodEnd: bounds.end,
    cancelAtPeriodEnd: ending.isEndingLater,
    createdAt: Date.parse(mollie.createdAt),
    vendorData: Object.freeze({
      status: mollie.status,
      startDate: mollie.startDate,
      nextPaymentDate: mollie.nextPaymentDate ?? null,
      interval: mollie.interval,
    }),
  };
  if (own.start === "trial") {
    result.trialEnd = StartOf(ParseDate(mollie.startDate));
  }
  if (ending.hasEnded) {
    result.endedAt = ending.endedAt;
    result.endReason = endReasonOf(record);
  }
  if (record.latest) result.latestPayment = record.latest.id;
  if (Object.keys(metadata).length > 0) result.metadata = metadata;
  return result;
}
