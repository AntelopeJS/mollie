import assert from "node:assert/strict";

import { InvalidSubscriptionRequestError } from "@antelopejs/interface-subscriptions";
import fc from "fast-check";

import {
  AddPeriods,
  DateOf,
  FormatDate,
  FromMollieInterval,
  NextDateFrom,
  ParseDate,
  type Period,
  StartOf,
  ToMollieInterval,
} from "../implementations/subscriptions/calendar";
import { ToSubscription } from "../implementations/subscriptions/mapping";
import type { SubscriptionRecord } from "../implementations/subscriptions/records";
import {
  AnyCountArb,
  DAY_MS,
  DateArb,
  ExpectedAddPeriods,
  ExpectedDateOf,
  ExpectedDayLength,
  ExpectedStartOf,
  FromOrdinal,
  HOUR_MS,
  InstantArb,
  LONGEST,
  MonthLength,
  Ordinal,
  PeriodArb,
  Transitions,
  WallClock,
} from "./support/calendar-model";

const DEFAULT_SEED = 20261112;
const RUNS = 300;
const MAX_PERIODS = 40;
const MAX_STEPS = 24;
const SUITE_TIMEOUT_MS = 60_000;
const DAILY: Period = { interval: "day", count: 1 };
const INTERVALS = ["day", "week", "month", "year"] as const;

const requestedSeed = Number.parseInt(process.env.FC_SEED ?? "", 10);
const PARAMETERS = {
  seed: Number.isInteger(requestedSeed) ? requestedSeed : DEFAULT_SEED,
  numRuns: RUNS,
};

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function isoOf(date: { year: number; month: number; day: number }): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

function recordOf(
  anchor: { year: number; month: number; day: number },
  period: Period,
  extras: { start?: "anchor" | "trial"; nextPaymentDate?: string } = {},
): SubscriptionRecord {
  const mollie: SubscriptionRecord["mollie"] = {
    resource: "subscription",
    id: "sub_property",
    status: "active",
    amount: { currency: "EUR", value: "10.00" },
    interval: ToMollieInterval(period),
    startDate: isoOf(anchor),
    description: "Subscription (property)",
    customerId: "cst_property",
    createdAt: new Date(ExpectedStartOf(anchor) - 2 * DAY_MS).toISOString(),
  };
  if (extras.nextPaymentDate !== undefined) {
    mollie.nextPaymentDate = extras.nextPaymentDate;
  }
  return {
    id: "sub_property",
    mollie,
    own: {
      reference: "property",
      interval: period.interval,
      intervalCount: period.count,
      start: extras.start ?? "anchor",
    },
  };
}

function schedule(
  anchor: { year: number; month: number; day: number },
  period: Period,
  index: number,
): number {
  return ExpectedStartOf(ExpectedAddPeriods(anchor, period, index));
}

function within(start: number, end: number, position: number): number {
  return (
    start + Math.min(end - start - 1, Math.floor(position * (end - start)))
  );
}

const POSITION = fc.oneof(
  fc.constantFrom(0, 1),
  fc.double({ min: 0, max: 1, noNaN: true }),
);

const midnightIsLocal = fc.property(InstantArb, (instant) => {
  const date = DateOf(instant);
  assert.deepEqual(date, ExpectedDateOf(instant));
  const midnight = StartOf(date);
  const clock = WallClock(midnight);
  assert.equal(clock.time, "00:00:00");
  assert.deepEqual(clock.date, date);
  assert.equal(midnight, ExpectedStartOf(date));
  assert.ok(midnight <= instant, "the day starts after the instant");
  assert.ok(
    StartOf(AddPeriods(date, DAILY, 1)) > instant,
    "the next day starts at or before the instant",
  );
});

const dayLength = fc.property(DateArb, (date) => {
  const length = StartOf(AddPeriods(date, DAILY, 1)) - StartOf(date);
  assert.equal(length, ExpectedDayLength(date));
  const start = StartOf(date);
  const subscription = ToSubscription(
    recordOf(date, DAILY),
    start + length - 1,
  );
  assert.equal(subscription.currentPeriodStart, start);
  assert.equal(subscription.currentPeriodEnd - start, length);
});

const nextDateRounding = fc.property(
  InstantArb,
  fc.integer({ min: 0, max: 3 * DAY_MS }),
  (instant, gap) => {
    const date = NextDateFrom(instant);
    const midnight = StartOf(date);
    assert.equal(midnight, ExpectedStartOf(date));
    assert.ok(midnight >= instant, "rounded time goes backwards");
    const previous = ExpectedStartOf(FromOrdinal(Ordinal(date) - 1));
    assert.ok(previous < instant, "rounded past an earlier midnight");
    assert.deepEqual(NextDateFrom(midnight), date);
    assert.deepEqual(NextDateFrom(midnight - 1), date);
    const later = NextDateFrom(instant + gap);
    assert.ok(Ordinal(later) >= Ordinal(date), "rounding is not monotonic");
  },
);

const periodArithmetic = fc.property(
  DateArb,
  PeriodArb,
  fc.integer({ min: 1, max: MAX_STEPS }),
  (anchor, period, steps) => {
    assert.deepEqual(AddPeriods(anchor, period, 0), anchor);
    let previous = anchor;
    for (let times = 1; times <= steps; times += 1) {
      const date = AddPeriods(anchor, period, times);
      assert.deepEqual(date, ExpectedAddPeriods(anchor, period, times));
      assert.ok(date.month >= 1 && date.month <= 12, "month out of range");
      assert.ok(
        date.day >= 1 && date.day <= MonthLength(date.year, date.month),
        `${isoOf(date)} is not a calendar date`,
      );
      const isMonthly =
        period.interval === "month" || period.interval === "year";
      if (isMonthly) {
        assert.equal(
          date.day,
          Math.min(anchor.day, MonthLength(date.year, date.month)),
        );
      }
      assert.ok(
        Ordinal(date) > Ordinal(previous),
        "a period repeats or goes back",
      );
      previous = date;
    }
    assert.deepEqual(
      AddPeriods(anchor, period, -1),
      ExpectedAddPeriods(anchor, period, -1),
    );
  },
);

const periodBoundsStepped = fc.property(
  DateArb,
  PeriodArb,
  fc.integer({ min: 0, max: MAX_PERIODS }),
  POSITION,
  (anchor, period, index, position) => {
    const start = schedule(anchor, period, index);
    const end = schedule(anchor, period, index + 1);
    const now = within(start, end, position);
    const subscription = ToSubscription(recordOf(anchor, period), now);
    assert.equal(subscription.currentPeriodStart, start);
    assert.equal(subscription.currentPeriodEnd, end);
    assert.equal(subscription.cancelAtPeriodEnd, false);
    assert.equal(WallClock(subscription.currentPeriodEnd).time, "00:00:00");
  },
);

const periodBoundsFromNextDate = fc.property(
  DateArb,
  PeriodArb,
  fc.integer({ min: 1, max: MAX_PERIODS }),
  POSITION,
  (anchor, period, index, position) => {
    const start = schedule(anchor, period, index - 1);
    const end = schedule(anchor, period, index);
    const now = within(start, end, position);
    const next = isoOf(ExpectedAddPeriods(anchor, period, index));
    const subscription = ToSubscription(
      recordOf(anchor, period, { nextPaymentDate: next }),
      now,
    );
    assert.equal(subscription.currentPeriodEnd, end);
    assert.equal(
      subscription.currentPeriodStart,
      start,
      `a period ending ${next} starts ${new Date(subscription.currentPeriodStart).toISOString()}, not ${new Date(start).toISOString()}`,
    );
  },
);

const wireRoundTrip = fc.property(
  PeriodArb,
  InstantArb,
  DateArb,
  fc.integer({ min: 0, max: MAX_STEPS }),
  (period, requested, anchor, times) => {
    const text = ToMollieInterval(period);
    const amount =
      period.interval === "year" ? period.count * 12 : period.count;
    const unit = period.interval === "year" ? "month" : period.interval;
    assert.equal(text, `${amount} ${unit}${amount === 1 ? "" : "s"}`);
    const read = FromMollieInterval(text);
    assert.deepEqual(read, {
      interval: unit,
      count: amount,
    });
    assert.deepEqual(
      AddPeriods(anchor, read, times),
      AddPeriods(anchor, period, times),
    );
    const date = NextDateFrom(requested);
    assert.match(FormatDate(date), /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(ParseDate(FormatDate(date)), date);
    const subscription = ToSubscription(
      recordOf(date, period, { start: "trial" }),
      requested,
    );
    assert.equal(subscription.trialEnd, StartOf(date));
    assert.ok(
      subscription.trialEnd !== undefined && subscription.trialEnd >= requested,
    );
    assert.ok(subscription.trialEnd - requested < 25 * HOUR_MS);
    assert.equal(subscription.interval, period.interval);
    assert.equal(subscription.intervalCount, period.count);
    assert.equal(subscription.vendorData?.interval, text);
  },
);

const unitLimits = fc.property(
  fc.constantFrom(...INTERVALS),
  AnyCountArb,
  (interval, count) => {
    const convert = () => ToMollieInterval({ interval, count });
    if (count <= LONGEST[interval]) {
      assert.match(convert(), /^\d+ (day|days|week|weeks|month|months)$/);
    } else {
      assert.throws(convert, InvalidSubscriptionRequestError);
    }
  },
);

function holds<Ts extends unknown[]>(
  name: string,
  claim: string,
  property: fc.IProperty<Ts>,
) {
  it(`holds ${name}: ${claim}`, () => {
    const details = fc.check(property, PARAMETERS);
    assert.ok(!details.failed, fc.defaultReportMessage(details));
  });
}

function finding<Ts extends unknown[]>(
  name: string,
  claim: string,
  property: fc.IProperty<Ts>,
) {
  it(`finding ${name}: ${claim}`, () => {
    const details = fc.check(property, PARAMETERS);
    assert.ok(details.failed, `${name} now holds: record it as holds`);
  });
}

function periodStartFromNextDate(
  anchor: string,
  period: Period,
  next: string,
  now: string,
): string {
  const record = recordOf(ParseDate(anchor), period, { nextPaymentDate: next });
  const { currentPeriodStart } = ToSubscription(
    record,
    StartOf(ParseDate(now)),
  );
  return FormatDate(DateOf(currentPeriodStart));
}

describe("[mollie] Europe/Amsterdam calendar properties", function () {
  this.timeout(SUITE_TIMEOUT_MS);

  holds(
    "midnightIsLocal",
    "a date starts at a real local midnight, no later than the instant and before the next day",
    midnightIsLocal,
  );
  holds(
    "dayLength",
    "a day lasts 24 hours, 23 on the March change and 25 on the October change, in the module and as a period",
    dayLength,
  );
  holds(
    "nextDateRounding",
    "rounding up reaches the next Amsterdam midnight, never backwards, once",
    nextDateRounding,
  );
  holds(
    "periodArithmetic",
    "adding periods never skips or repeats a date and clamps month ends",
    periodArithmetic,
  );
  holds(
    "periodBoundsStepped",
    "the period read from the start date is the schedule's own period",
    periodBoundsStepped,
  );
  finding(
    "periodBoundsFromNextDate",
    "the period read from Mollie's next payment date is the schedule's own period",
    periodBoundsFromNextDate,
  );
  holds(
    "wireRoundTrip",
    "the interval and start date the module sends read back as the same schedule",
    wireRoundTrip,
  );
  holds(
    "unitLimits",
    "Mollie's longest interval is the refused boundary",
    unitLimits,
  );

  it("pins periodBoundsFromNextDate: a clamped next payment date starts its period on the clamped day", () => {
    const monthly: Period = { interval: "month", count: 1 };
    const yearly: Period = { interval: "year", count: 1 };
    assert.equal(
      periodStartFromNextDate(
        "2027-01-31",
        monthly,
        "2027-03-31",
        "2027-03-10",
      ),
      "2027-02-28",
    );
    assert.equal(
      periodStartFromNextDate(
        "2027-01-31",
        monthly,
        "2027-02-28",
        "2027-02-10",
      ),
      "2027-01-28",
      "the scheduled previous date is 2027-01-31",
    );
    assert.equal(
      periodStartFromNextDate(
        "2027-01-31",
        monthly,
        "2027-02-28",
        "2027-01-31",
      ),
      "2027-01-28",
    );
    assert.equal(
      periodStartFromNextDate("2028-02-29", yearly, "2029-02-28", "2028-06-01"),
      "2028-02-28",
      "the scheduled previous date is 2028-02-29",
    );
    const withoutNext = recordOf(ParseDate("2027-01-31"), monthly);
    const { currentPeriodStart } = ToSubscription(
      withoutNext,
      StartOf(ParseDate("2027-02-10")),
    );
    assert.equal(
      FormatDate(DateOf(currentPeriodStart)),
      "2027-01-31",
      "without a next payment date, the same period starts on the anchor day",
    );
  });

  it("generates both daylight-saving days, February 29 and month ends", () => {
    const dates = fc.sample(DateArb, PARAMETERS);
    const lengths = dates.map(ExpectedDayLength);
    assert.ok(lengths.includes(23 * HOUR_MS), "no 23-hour day");
    assert.ok(lengths.includes(25 * HOUR_MS), "no 25-hour day");
    assert.ok(
      dates.some((date) => date.month === 2 && date.day === 29),
      "no February 29",
    );
    assert.ok(
      dates.some(
        (date) =>
          date.day === MonthLength(date.year, date.month) && date.day >= 30,
      ),
      "no 30th or 31st month end",
    );
    assert.ok(
      dates.some((date) => date.month === 12 && date.day === 31),
      "no year end",
    );
    assert.ok(Transitions(2026).toSummer < Transitions(2026).toWinter);
  });
});
