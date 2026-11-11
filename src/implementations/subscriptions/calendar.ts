import {
  InvalidSubscriptionRequestError,
  SUBSCRIPTION_INTERVALS,
  type SubscriptionInterval,
} from "@antelopejs/interface-subscriptions";

const MOLLIE_TIME_ZONE = "Europe/Amsterdam";

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface Period {
  interval: SubscriptionInterval;
  count: number;
}

interface MollieUnit {
  singular: string;
  plural: string;
  perInterval: number;
  maximum: number;
}

const MS_PER_SECOND = 1000;
const DAYS_PER_WEEK = 7;
const MONTHS_PER_YEAR = 12;
const BASE = 10;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MOLLIE_INTERVAL = /^(\d+) (day|days|week|weeks|month|months)$/;

const UNIT_BY_INTERVAL: Record<SubscriptionInterval, MollieUnit> = {
  day: { singular: "day", plural: "days", perInterval: 1, maximum: 365 },
  week: { singular: "week", plural: "weeks", perInterval: 1, maximum: 52 },
  month: { singular: "month", plural: "months", perInterval: 1, maximum: 12 },
  year: {
    singular: "month",
    plural: "months",
    perInterval: MONTHS_PER_YEAR,
    maximum: MONTHS_PER_YEAR,
  },
};

const FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: MOLLIE_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function zonedParts(instant: number): Record<string, number> {
  return Object.fromEntries(
    FORMATTER.formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number.parseInt(part.value, BASE)]),
  );
}

function offsetAt(instant: number): number {
  const parts = zonedParts(instant);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(instant / MS_PER_SECOND) * MS_PER_SECOND;
}

export function DateOf(instant: number): CalendarDate {
  const parts = zonedParts(instant);
  return { year: parts.year, month: parts.month, day: parts.day };
}

export function StartOf(date: CalendarDate): number {
  const utcMidnight = Date.UTC(date.year, date.month - 1, date.day);
  const guess = utcMidnight - offsetAt(utcMidnight);
  return utcMidnight - offsetAt(guess);
}

export function FormatDate(date: CalendarDate): string {
  const pad = (value: number, width: number) =>
    String(value).padStart(width, "0");
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

export function ParseDate(text: string): CalendarDate {
  const match = ISO_DATE.exec(text);
  if (!match) {
    throw new RangeError(`"${text}" is not a YYYY-MM-DD date`);
  }
  return {
    year: Number.parseInt(match[1], BASE),
    month: Number.parseInt(match[2], BASE),
    day: Number.parseInt(match[3], BASE),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

function addMonths(
  date: CalendarDate,
  months: number,
  anchorDay: number,
): CalendarDate {
  const index = date.year * MONTHS_PER_YEAR + (date.month - 1) + months;
  const year = Math.floor(index / MONTHS_PER_YEAR);
  const month = (index % MONTHS_PER_YEAR) + 1;
  return { year, month, day: Math.min(anchorDay, daysInMonth(year, month)) };
}

/**
 * Whether Mollie can bill `period`: a whole count of at least one, no longer
 * than Mollie's longest interval for its unit.
 */
export function IsBillablePeriod(period: Period): boolean {
  const unit = UNIT_BY_INTERVAL[period.interval];
  return (
    Number.isInteger(period.count) &&
    period.count >= 1 &&
    period.count * unit.perInterval <= unit.maximum
  );
}

/**
 * The schedule date `times` periods after `anchor`. Throws a `RangeError` for
 * a count that is not a whole number of at least one, which no schedule has.
 */
export function AddPeriods(
  anchor: CalendarDate,
  period: Period,
  times: number,
): CalendarDate {
  if (!Number.isInteger(period.count) || period.count < 1) {
    throw new RangeError(
      `An interval count is a whole number of at least 1, not ${period.count}`,
    );
  }
  const total = period.count * times;
  const unitsByInterval: Record<SubscriptionInterval, () => CalendarDate> = {
    day: () => addDays(anchor, total),
    week: () => addDays(anchor, total * DAYS_PER_WEEK),
    month: () => addMonths(anchor, total, anchor.day),
    year: () => addMonths(anchor, total * MONTHS_PER_YEAR, anchor.day),
  };
  return unitsByInterval[period.interval]();
}

const MS_PER_DAY = 86_400_000;

function unitsBetween(
  anchor: CalendarDate,
  date: CalendarDate,
  interval: Period["interval"],
): number {
  const months =
    (date.year - anchor.year) * MONTHS_PER_YEAR + (date.month - anchor.month);
  const days =
    (Date.UTC(date.year, date.month - 1, date.day) -
      Date.UTC(anchor.year, anchor.month - 1, anchor.day)) /
    MS_PER_DAY;
  const byInterval: Record<Period["interval"], number> = {
    day: days,
    week: days / DAYS_PER_WEEK,
    month: months,
    year: months / MONTHS_PER_YEAR,
  };
  return byInterval[interval];
}

/**
 * The last schedule date that starts strictly before `end`, counted from
 * `anchor`, so a month or year period keeps the anchor's day after a clamped
 * month end. Constant time, whatever the number of periods since the anchor:
 * the index is estimated from the elapsed days or months, then corrected
 * against the schedule's own dates.
 */
export function PeriodStartBefore(
  anchor: CalendarDate,
  period: Period,
  end: number,
): CalendarDate {
  const elapsed = unitsBetween(anchor, DateOf(end), period.interval);
  let index = Math.max(0, Math.floor(elapsed / period.count));
  while (index > 0 && StartOf(AddPeriods(anchor, period, index)) >= end) {
    index -= 1;
  }
  while (StartOf(AddPeriods(anchor, period, index + 1)) < end) {
    index += 1;
  }
  return AddPeriods(anchor, period, index);
}

export function NextDateFrom(instant: number): CalendarDate {
  const today = DateOf(instant);
  return StartOf(today) >= instant ? today : addDays(today, 1);
}

export function ToMollieInterval(period: Period): string {
  const unit = UNIT_BY_INTERVAL[period.interval];
  const amount = period.count * unit.perInterval;
  if (amount > unit.maximum) {
    throw new InvalidSubscriptionRequestError(
      `Mollie bills at most once every ${unit.maximum} ${unit.plural}; ${period.count} ${period.interval}(s) is longer`,
    );
  }
  return `${amount} ${amount === 1 ? unit.singular : unit.plural}`;
}

function isSubscriptionInterval(
  value: string | undefined,
): value is SubscriptionInterval {
  return SUBSCRIPTION_INTERVALS.some((interval) => interval === value);
}

export function FromMollieInterval(interval: string): Period {
  const match = MOLLIE_INTERVAL.exec(interval.trim());
  const unit = match?.[2].replace(/s$/, "");
  if (!match || !isSubscriptionInterval(unit)) {
    throw new RangeError(`Mollie interval "${interval}" is not understood`);
  }
  const count = Number.parseInt(match[1], BASE);
  return { interval: unit, count };
}
