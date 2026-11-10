---
name: formal-amsterdam-calendar
description: Checks the module's Europe/Amsterdam calendar logic with generated instants, periods and counts across daylight-saving changes and month ends. Use when changing subscriptions/calendar.ts, the period reading in subscriptions/mapping.ts, or how creation.ts turns a trial end, billing anchor or interval into what Mollie receives.
---

# Check the Europe/Amsterdam calendar

Run this check when a change touches the coverage record below.

Mollie schedules by calendar date and names no time zone. The module reads each date as a day in Europe/Amsterdam (`docs/4.subscriptions.md`, Time and Intervals). A wrong midnight on a daylight-saving day, a skipped or repeated date, or a month end that drifts bills a customer a day early or late, and no Mollie response shows it.

## Run the check

From the repository root, run:

```sh
pnpm run build && pnpm exec ajs module test . -f dist/test/calendar.properties.test.js
```

`antelopejs-verify formal <run>` runs the same command. The test uses fast-check 4.3.0, pinned as a devDependency. Each property requests 300 runs. The default seed is `20261112`. Set `FC_SEED` to the integer a failure prints to replay another run. Keep the generators and the fast-check version unchanged when replaying a seed. A failure prints the shrink path and the shrunk counterexample.

The output names each property on its own line. `holds <name>` is a property that passes. A numbered `holds` line is a break. No finding is recorded.

## The properties

The oracle is `src/test/support/calendar-model.ts`. It states the EU rule (summer time from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October) and the Gregorian month lengths with plain arithmetic, and reads the wall clock through its own `Intl` formatter. It shares no code with the module.

| Property | What must hold |
| --- | --- |
| `midnightIsLocal` | `DateOf(t)` is the Amsterdam date of `t`. `StartOf` of it formats to `00:00:00` on that date in Europe/Amsterdam, is at or before `t`, and the next day starts after `t`. |
| `dayLength` | A day lasts 24 hours, 23 on the last Sunday of March and 25 on the last Sunday of October. A daily subscription period anchored on that day reads back with the same length. |
| `nextDateRounding` | `NextDateFrom(t)` starts at or after `t`, no earlier midnight is at or after `t`, rounding the result again, or one millisecond before it, gives the same date, and a later instant never rounds to an earlier date. |
| `periodArithmetic` | `AddPeriods(anchor, period, n)` is the anchor for `n = 0`, adds exactly `count` days or `7 * count` days, or exactly `count` or `12 * count` months. A month result keeps the anchor's day and clamps to the last day of a shorter month, so January 31 plus one month is February 28 or 29 and plus two months is March 31. Every result is a real date and later than the one before. |
| `periodBoundsStepped` | For a subscription with no next payment date, `ToSubscription` reads the period holding any instant as the schedule's own period: `currentPeriodStart` and `currentPeriodEnd` are the Amsterdam midnights of two consecutive schedule dates, at every millisecond from one midnight to the next. |
| `periodBoundsFromNextDate` | When Mollie reports `nextPaymentDate` as the schedule's date and that date is not a clamped month end (a month or year period whose date is not the anchor's day), `currentPeriodEnd` is the Amsterdam midnight of that date, on that date, and `currentPeriodStart` is the Amsterdam midnight of the schedule date `count` periods before it. |
| `periodBoundsFromClampedNextDate` | The same, when the next payment date is a clamped month end: January 31 with next date February 28 starts on January 31, not January 28. Fixed, see Findings. |
| `wireRoundTrip` | `ToMollieInterval` writes `n day(s)`, `n week(s)` or `n month(s)`, with the singular only for 1 and a year as `12 * count months`. `FromMollieInterval` reads it back as the same schedule: the same period, except that a year reads as 12 months, and both add the same dates from any anchor. `FormatDate` writes `YYYY-MM-DD` and `ParseDate` reads it back. A trial end rounds to `StartOf(NextDateFrom(t))`, within 25 hours after `t`. The subscription reports the interval, the count and Mollie's interval text it was given. |
| `unitLimits` | `ToMollieInterval` accepts a count exactly up to the longest interval of the Intervals table (day 365, week 52, month 12, year 1) and throws `InvalidSubscriptionRequestError` for every count above it. |

The generators weight the inputs the module is most likely to get wrong. Instants run from 1996 to 2100. Of eleven draws, four land on a transition or on a local midnight beside one, three in the last four days of a month, one around February 29 of a leap year, one around a year end and two anywhere. Periods cover every interval with counts from 1 to its limit, and the edge counts are drawn on purpose. The two next-date properties split one generated input by `isClampedNextDate`, so each runs only on its own side and `fc.pre` discards the other, and a break on one side cannot hide behind the other. `periodArithmetic` takes up to 24 steps and the two reading properties up to 40 periods from the anchor.

## Judge the result

1. Read the shrunk counterexample. A date is `{year, month, day}`, an instant is epoch milliseconds, a period is `{interval, count}`, and the numbers after a period are the period index and the position inside it (0 is the first millisecond, 1 the last).
2. Replay it through the public functions named in the property before you judge. A failure in `calendar-model.ts` is an oracle error until that replay shows the module wrong.
3. A property that fails is a product finding. Report the counterexample before you propose a fix, exclude inputs, skip the property or loosen the oracle. Do not fix `calendar.ts` or `mapping.ts` in the pull request that adds or changes this check: `antelopejs-verify formal` fails a check that lands with a covered-code change.
4. Fix the finding in its own pull request, which runs `formal` on the base and reports the rule fixed. Until then the check fails: nothing records a finding that stands.

## Bounds and exclusions

This is randomized testing of real code, not an exhaustive proof. It does not cover:

- Instants before 1996. Until 1995 the EU ended summer time on the last Sunday of September, and the Netherlands had no summer time before 1977. The oracle states only the 1996 rule.
- Years after 2100, except dates a period reaches from an anchor (up to 40 periods).
- Anything Mollie does. The oracle is the documented contract, not a recording of Mollie. Whether Mollie moves a clamped month back to the anchor day (January 31, February 28, March 31) or keeps the clamped day (March 28) is not observed here. The module assumes the first.
- `PERIOD_SEARCH_LIMIT`. `steppedBounds` stops after 10,000 periods, so a subscription read more than 10,000 periods after its anchor, a daily one older than 27 years, reports the 10,000th period. No property generates it.
- A period before the first schedule date, a trial, a cancellation with `period_end` and the `endingBefore` first-period branch. The unit and conformance suites own those.
- `creation.ts`: `scheduleOf` and the body it builds are private. The property tests call the same `NextDateFrom`, `AddPeriods`, `ToMollieInterval` and `FormatDate` it calls, but not its choices, such as `AddPeriods(DateOf(Date.now()), period, 1)` for a first charged period.
- Counts that are not positive integers. The interface's `ValidateSubscriptionRequest` refuses them before the module sees them.
- Time zones other than Europe/Amsterdam, and Node without full ICU.

The equivalent mutant shows the limit of the oracle. `StartOf` reads the offset twice, at the UTC midnight and again at the first guess. Reading it once gives the same result for every date in Europe/Amsterdam, because the transitions fall at 01:00 UTC, after the UTC midnight of the same day, so the second read never differs. The second read matters for zones the module does not use.

## Coverage record

Last code synchronization is `FIXSHA`, the commit that makes `endingBefore` step from the anchor.

| File | Covered functions and role |
| --- | --- |
| `src/implementations/subscriptions/calendar.ts` | `DateOf`, `StartOf`, `FormatDate`, `ParseDate`, `AddPeriods`, `NextDateFrom`, `ToMollieInterval`, `FromMollieInterval` and the private `zonedParts`, `offsetAt`, `addDays`, `addMonths`, `daysInMonth`. |
| `src/implementations/subscriptions/mapping.ts` | `ToSubscription` through `boundsAt`, `steppedBounds` and `endingBefore` for the period, `trialEnd`, `interval`, `intervalCount` and `vendorData.interval`. Status, ending and metadata are not covered. |
| `src/test/calendar.properties.test.ts` | The properties, the seed, the run count and the generator coverage tests. |
| `src/test/support/calendar-model.ts` | The oracle and the generators. |

`creation.ts` calls the covered functions and is not covered (see Bounds). A change that alters which date it passes to them needs this check read again.

After covered code changes, compare their behavior with the properties above and rerun the check. Move the synchronization commit forward only after confirming that the test still describes the new code.

Generator coverage at the default seed, over 300 sampled dates: 33 are 23-hour days, 29 are 25-hour days, 13 are February 29, 62 are the 30th or 31st ending their month, 145 are the 29th or later, and 29 are December 31. The 300 sampled periods are 79 days, 68 weeks, 81 months and 72 years, and 100 of them use the interval's longest count. `generates both daylight-saving days, February 29 and month ends` fails when a change to the generators loses one of these classes. `generates next payment dates on both sides of a clamped month end` fails when the generators draw no clamped next date, which would empty `periodBoundsFromClampedNextDate`, or no monthly date on the 29th or later that keeps the anchor's day, which would let `periodBoundsFromNextDate` pass without testing a month end.

## Findings

None recorded.

### Fixed: `periodBoundsFromClampedNextDate`

Found on the first run, at `6747973`, and fixed at `FIXSHA`. `endingBefore` in `mapping.ts` computed a period's start as `AddPeriods(DateOf(end), period, -1)`, one period back from the `nextPaymentDate` Mollie reports. Counted from a clamped month end, that loses the anchor's day: a monthly subscription anchored 2027-01-31 with `nextPaymentDate` 2027-02-28 started its period on 2027-01-28, while the same record read without `nextPaymentDate` (`steppedBounds`) started on 2027-01-31. The shrunk counterexample at seed `20261112` was:

```text
[{"year":1996,"month":7,"day":31},{"interval":"month","count":1},11,0]
a period ending 1997-06-30 starts 1997-05-29T22:00:00.000Z, not 1997-05-30T22:00:00.000Z
```

A yearly subscription anchored 2028-02-29 with next date 2029-02-28 had the same fault. The fix reads the start as `steppedBounds(record, end - 1).start`: the schedule date before `end`, counted from the anchor. The finding is now `holds periodBoundsFromClampedNextDate` and its pinned test is gone. `[mollie] subscription periods` in `src/test/units.test.ts` holds the three smallest cases. The documentation already said "Month periods keep the anchor's day of the month"; the code now does.

## Mutation evidence

Each scratch change below was applied to the current code, caught with the shrunk counterexample shown, and removed. The check then reported 11 passing again, the generator tests included. `git diff --stat src/implementations` was empty afterward. Counterexamples are at the default seed. `next` is `periodBoundsFromNextDate` and `clamped` is `periodBoundsFromClampedNextDate`, the two properties over the `nextPaymentDate` path that every active subscription takes.

| Scratch change | Properties that failed, first counterexample |
| --- | --- |
| `StartOf`: `utcMidnight - 3600000` for every date (`calendar.ts`) | `midnightIsLocal` `[828309600000]`, `dayLength` `[1996-03-31]`, `nextDateRounding` `[828230400000,0]`, `periodBoundsStepped` `[1996-01-01, day×31, 2, 0]`, `next` `[1996-03-31, day×1, 1, 0]`, `clamped` `[1996-07-31, month×1, 11, 0]` |
| `StartOf`: second read at `utcMidnight + 86400000` | `midnightIsLocal` `[828230400000]`, `dayLength` `[1996-03-31]`, `nextDateRounding` `[828223200000,0]`, `periodBoundsStepped` `[1996-03-31, day×1, 0, 0]`, `next` `[1996-03-31, day×1, 1, 0]`, `clamped` `[2094-10-31, month×1, 1, 0]`, `wireRoundTrip` `[day×1, 828223200001, 1996-12-31, 0]` |
| `StartOf`: one offset read instead of two | survives: equivalent mutant, see Bounds |
| `DateOf`: UTC date instead of Amsterdam date | `midnightIsLocal` `[828309600000]`, `nextDateRounding` `[828313200001,0]`, `wireRoundTrip` `[day×1, 4133977200001, 1996-02-29, 0]` |
| `NextDateFrom`: `>` for `>=` | `nextDateRounding` `[828230400000,0]`, `wireRoundTrip` `[day×1, 846367200000, 1996-03-31, 0]` |
| `addMonths`: no clamp, `day: anchorDay` | `periodArithmetic` `[1996-01-31, month×1, 1]`, `periodBoundsStepped` `[1996-01-31, month×1, 0, 0]`, `next` `[1996-01-31, month×11, 3, 0]`, `clamped` `[1996-12-31, month×10, 4, 0]` |
| `AddPeriods`: a year adds 1 month, not 12 | `periodArithmetic` `[1996-03-31, year×1, 1]`, `periodBoundsStepped` `[1996-03-31, year×1, 0, 0]`, `next` `[1996-03-31, year×1, 1, 0]`, `clamped` `[1996-02-29, year×1, 1, 0]`, `wireRoundTrip` `[year×1, 820454400000, 1996-02-29, 1]` |
| `AddPeriods`: a week adds `count` days | `periodArithmetic` `[1996-12-31, week×1, 1]`, `periodBoundsStepped` `[1996-12-31, week×1, 0, 0]`, `next` `[1996-12-31, week×1, 1, 0]` |
| `ToMollieInterval`: `>=` for `>` against the limit | `unitLimits` `["week",52]`, `periodBoundsStepped` `[1996-03-31, day×365, 0, 0]`, `next` `[1996-03-31, day×365, 1, 0]`, `clamped` `[1996-02-29, year×1, 1, 0]`, `wireRoundTrip` `[day×365, 828230400000, 1996-01-01, 0]` |
| `ToMollieInterval`: singular for 0, not 1 | `wireRoundTrip` `[week×1, 823046400000, 1996-12-31, 0]` |
| `FormatDate`: day padded to 1 digit | `wireRoundTrip` `[day×1, 820454400000, 1996-02-29, 0]` |
| `steppedBounds`: `<` for `<=` (`mapping.ts`) | `periodBoundsStepped` `[1996-01-31, day×1, 1, 0]` |
| `steppedBounds`: start of the next period (`mapping.ts`) | `dayLength` `[1996-03-31]`, `periodBoundsStepped` `[1996-03-31, day×1, 0, 0]`, `next` `[1996-03-31, day×1, 1, 0]`, `clamped` `[1996-07-31, month×1, 11, 0]` |
| `boundsAt`: the next payment date ends at UTC midnight, `Date.UTC(d.year, d.month - 1, d.day)` for `StartOf(ParseDate(next))` (`mapping.ts`) | `next` `[1996-03-31, day×1, 1, 0]`, `clamped` `[1996-07-31, month×1, 11, 0]` |
| `endingBefore`: the start one period back from the end, `StartOf(AddPeriods(DateOf(end), periodOf(record), -1))`, the code before the fix (`mapping.ts`) | `clamped` `[1996-07-31, month×1, 11, 0]` |
| `endingBefore`: the same with `{ interval, count: 1 }` for `periodOf(record)`, so the count is ignored | `next` `[1996-01-31, day×2, 1, 0]`, `clamped` `[1996-07-31, month×1, 11, 0]` |
| `endingBefore`: `steppedBounds(record, end).start`, the period that starts at the end date | `next` `[1996-03-31, day×1, 1, 0]`, `clamped` `[1996-07-31, month×1, 11, 0]` |

Every property fails under at least one scratch change. The split matters: the code before the fix fails `clamped` alone, so a pinned or recorded finding on the whole `nextPaymentDate` path would have hidden the `count` and end-date mutants from `next`. A review of the first version of this check found that those mutants passed all ten of its tests while the property over that path was a recorded finding, because a finding accepts any failure.
