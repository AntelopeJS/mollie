import { SUBSCRIPTION_INTERVALS } from "@antelopejs/interface-subscriptions";
import type { SubscriptionInterval } from "@antelopejs/interface-subscriptions";
import fc from "fast-check";

import type {
  CalendarDate,
  Period,
} from "../../implementations/subscriptions/calendar";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

const FIRST_YEAR = 1996;
const LAST_YEAR = 2100;
const MARCH = 3;
const OCTOBER = 10;
const MONTHS_PER_YEAR = 12;
const DAYS_PER_WEEK = 7;
const SUNDAY_OF_EPOCH_OFFSET = 4;
const FEBRUARY = 2;
const GREGORIAN_CYCLE = 400;
const CENTURY = 100;
const LEAP_CYCLE = 4;
const LONG_MONTHS = new Set([1, 3, 5, 7, 8, 10, 12]);
const SHORT_MONTHS = new Set([4, 6, 9, 11]);

/**
 * What Mollie bills at most, per interface interval, as the "Intervals" table
 * of `docs/4.subscriptions.md` lists it.
 */
export const LONGEST: Record<SubscriptionInterval, number> = {
  day: 365,
  week: 52,
  month: 12,
  year: 1,
};

const DAYS_PER_STEP: Record<SubscriptionInterval, number> = {
  day: 1,
  week: DAYS_PER_WEEK,
  month: 0,
  year: 0,
};

const MONTHS_PER_STEP: Record<SubscriptionInterval, number> = {
  day: 0,
  week: 0,
  month: 1,
  year: MONTHS_PER_YEAR,
};

const LOCAL_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Amsterdam",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function isLeapYear(year: number): boolean {
  const isCentury = year % CENTURY === 0;
  return isCentury ? year % GREGORIAN_CYCLE === 0 : year % LEAP_CYCLE === 0;
}

/** Days in a month, from the Gregorian rule alone. */
export function MonthLength(year: number, month: number): number {
  if (LONG_MONTHS.has(month)) return 31;
  if (SHORT_MONTHS.has(month)) return 30;
  return isLeapYear(year) ? 29 : 28;
}

/** Whole days since 1970-01-01 of a calendar date. */
export function Ordinal(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
}

/** The calendar date `ordinal` days after 1970-01-01. */
export function FromOrdinal(ordinal: number): CalendarDate {
  const moved = new Date(ordinal * DAY_MS);
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

function lastSundayOrdinal(year: number, month: number): number {
  const last = Ordinal({ year, month, day: MonthLength(year, month) });
  return last - ((last + SUNDAY_OF_EPOCH_OFFSET) % DAYS_PER_WEEK);
}

/** The instants Europe/Amsterdam moves to summer time and back, 01:00 UTC. */
export function Transitions(year: number) {
  return {
    toSummer: lastSundayOrdinal(year, MARCH) * DAY_MS + HOUR_MS,
    toWinter: lastSundayOrdinal(year, OCTOBER) * DAY_MS + HOUR_MS,
  };
}

/** The Europe/Amsterdam date of an instant, from the EU transition rule. */
export function ExpectedDateOf(instant: number): CalendarDate {
  const { toSummer, toWinter } = Transitions(
    new Date(instant + HOUR_MS).getUTCFullYear(),
  );
  const isSummer = instant >= toSummer && instant < toWinter;
  return FromOrdinal(
    Math.floor((instant + (isSummer ? 2 : 1) * HOUR_MS) / DAY_MS),
  );
}

/** The instant a date starts in Europe/Amsterdam, from the EU transition rule. */
export function ExpectedStartOf(date: CalendarDate): number {
  const ordinal = Ordinal(date);
  const isSummer =
    ordinal > lastSundayOrdinal(date.year, MARCH) &&
    ordinal <= lastSundayOrdinal(date.year, OCTOBER);
  return ordinal * DAY_MS - (isSummer ? 2 : 1) * HOUR_MS;
}

/** The hours of a day in Europe/Amsterdam: 23 and 25 on the two changes. */
export function ExpectedDayLength(date: CalendarDate): number {
  return (
    ExpectedStartOf(FromOrdinal(Ordinal(date) + 1)) - ExpectedStartOf(date)
  );
}

/** The Europe/Amsterdam wall clock of an instant, read by the platform. */
export function WallClock(instant: number) {
  const parts = Object.fromEntries(
    LOCAL_CLOCK.formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
    },
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

/**
 * The date `times` periods after the anchor, as the documentation states it:
 * days and weeks add whole days; months and years move whole months and keep
 * the anchor's day of the month, clamped to the last day of a shorter month.
 */
export function ExpectedAddPeriods(
  anchor: CalendarDate,
  period: Period,
  times: number,
): CalendarDate {
  const steps = period.count * times;
  const daysPerStep = DAYS_PER_STEP[period.interval];
  if (daysPerStep !== 0) {
    return FromOrdinal(Ordinal(anchor) + steps * daysPerStep);
  }
  const index =
    anchor.year * MONTHS_PER_YEAR +
    (anchor.month - 1) +
    steps * MONTHS_PER_STEP[period.interval];
  const year = Math.floor(index / MONTHS_PER_YEAR);
  const month = (index % MONTHS_PER_YEAR) + 1;
  return { year, month, day: Math.min(anchor.day, MonthLength(year, month)) };
}

const YEAR = fc.integer({ min: FIRST_YEAR, max: LAST_YEAR });
const TIME_OF_DAY = fc.oneof(
  fc.integer({ min: 0, max: DAY_MS - 1 }),
  fc.constantFrom(0, 1, HOUR_MS, 22 * HOUR_MS, 23 * HOUR_MS, DAY_MS - 1),
);
const AROUND = fc.oneof(
  fc.integer({ min: -2 * HOUR_MS, max: 2 * HOUR_MS }),
  fc.constantFrom(-HOUR_MS, -1, 0, 1, HOUR_MS),
);
const TRANSITION_POSITIONS = [
  0,
  -2 * HOUR_MS,
  -3 * HOUR_MS,
  21 * HOUR_MS,
  22 * HOUR_MS,
  23 * HOUR_MS,
];

const uniformInstant = fc.integer({
  min: Date.UTC(FIRST_YEAR, 0, 1),
  max: Date.UTC(LAST_YEAR, 11, 31, 23, 59, 59, 999),
});

const transitionInstant = fc
  .record({
    year: YEAR,
    toWinter: fc.boolean(),
    position: fc.constantFrom(...TRANSITION_POSITIONS),
    around: AROUND,
  })
  .map(({ year, toWinter, position, around }) => {
    const transitions = Transitions(year);
    return (
      (toWinter ? transitions.toWinter : transitions.toSummer) +
      position +
      around
    );
  });

const monthEndInstant = fc
  .record({
    year: YEAR,
    month: fc.integer({ min: 1, max: MONTHS_PER_YEAR }),
    fromEnd: fc.integer({ min: 0, max: 3 }),
    time: TIME_OF_DAY,
  })
  .map(
    ({ year, month, fromEnd, time }) =>
      Date.UTC(year, month - 1, MonthLength(year, month) - fromEnd) + time,
  );

const leapDayInstant = fc
  .record({
    year: YEAR.filter((year) => MonthLength(year, FEBRUARY) === 29),
    time: TIME_OF_DAY,
    dayShift: fc.integer({ min: -1, max: 1 }),
  })
  .map(
    ({ year, time, dayShift }) =>
      Date.UTC(year, FEBRUARY - 1, 29 + dayShift) + time,
  );

const yearEndInstant = fc
  .record({ year: YEAR, offset: fc.integer({ min: 0, max: 4 * HOUR_MS }) })
  .map(({ year, offset }) => Date.UTC(year, 11, 31, 22) + offset);

/**
 * Instants from 1990 to 2100, weighted toward the two daylight-saving changes
 * (01:00 UTC on the last Sunday of March and October, and the local midnights
 * around them), the last four days of a month, February 29 and the year end.
 */
export const InstantArb = fc.oneof(
  { arbitrary: uniformInstant, weight: 2 },
  { arbitrary: transitionInstant, weight: 4 },
  { arbitrary: monthEndInstant, weight: 3 },
  { arbitrary: leapDayInstant, weight: 1 },
  { arbitrary: yearEndInstant, weight: 1 },
);

/** Calendar dates over the same span and weighting, read from a UTC instant. */
export const DateArb = InstantArb.map((instant): CalendarDate =>
  FromOrdinal(Math.floor(instant / DAY_MS)),
);

function countArb(interval: SubscriptionInterval): fc.Arbitrary<number> {
  const longest = LONGEST[interval];
  return fc.oneof(
    fc.integer({ min: 1, max: longest }),
    fc.constantFrom(1, Math.min(2, longest), Math.max(1, longest - 1), longest),
  );
}

/** Every interval with every count Mollie accepts for it, edges weighted. */
export const PeriodArb: fc.Arbitrary<Period> = fc
  .constantFrom(...SUBSCRIPTION_INTERVALS)
  .chain((interval) =>
    countArb(interval).map((count): Period => ({ interval, count })),
  );

/** Counts from 1 to well past every limit, with each limit's edges weighted. */
export const AnyCountArb = fc.oneof(
  fc.integer({ min: 1, max: 1000 }),
  fc
    .constantFrom(
      ...Object.values(LONGEST).flatMap((longest) => [
        longest - 1,
        longest,
        longest + 1,
      ]),
    )
    .filter((count) => count >= 1),
);
