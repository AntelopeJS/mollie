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

The output names each property on its own line. `holds <name>` is a property that passes. `finding <name>` is a recorded finding: its property still fails, as recorded below. A numbered `holds` or `finding` line is a break.

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
| `periodBoundsFromClampedNextDate` | The same, when the next payment date is a clamped month end. Recorded finding. |
| `wireRoundTrip` | `ToMollieInterval` writes `n day(s)`, `n week(s)` or `n month(s)`, with the singular only for 1 and a year as `12 * count months`. `FromMollieInterval` reads it back as the same schedule: the same period, except that a year reads as 12 months, and both add the same dates from any anchor. `FormatDate` writes `YYYY-MM-DD` and `ParseDate` reads it back. A trial end rounds to `StartOf(NextDateFrom(t))`, within 25 hours after `t`. The subscription reports the interval, the count and Mollie's interval text it was given. |
| `unitLimits` | `ToMollieInterval` accepts a count exactly up to the longest interval of the Intervals table (day 365, week 52, month 12, year 1) and throws `InvalidSubscriptionRequestError` for every count above it. |

The generators weight the inputs the module is most likely to get wrong. Instants run from 1996 to 2100. Of eleven draws, four land on a transition or on a local midnight beside one, three in the last four days of a month, one around February 29 of a leap year, one around a year end and two anywhere. Periods cover every interval with counts from 1 to its limit, and the edge counts are drawn on purpose. The two next-date properties split one generated input by `isClampedNextDate`, so each runs only on its own side and `fc.pre` discards the other. `periodArithmetic` takes up to 24 steps and the two reading properties up to 40 periods from the anchor.

## Judge the result

1. Read the shrunk counterexample. A date is `{year, month, day}`, an instant is epoch milliseconds, a period is `{interval, count}`, and the numbers after a period are the period index and the position inside it (0 is the first millisecond, 1 the last).
2. Replay it through the public functions named in the property before you judge. A failure in `calendar-model.ts` is an oracle error until that replay shows the module wrong.
3. A property that fails is a product finding. Report the counterexample before you propose a fix, exclude inputs, skip the property or loosen the oracle. Do not fix `calendar.ts` or `mapping.ts` in the pull request that adds or changes this check: `antelopejs-verify formal` fails a check that lands with a covered-code change.
4. When a recorded finding stops failing, `finding <name>` fails with "now holds". Rename it `holds <name>`, in the test and here, and remove its pinned test. When a property fails that is not recorded, the check fails.

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

Last code synchronization is the commit that adds this skill.

| File | Covered functions and role |
| --- | --- |
| `src/implementations/subscriptions/calendar.ts` | `DateOf`, `StartOf`, `FormatDate`, `ParseDate`, `AddPeriods`, `NextDateFrom`, `ToMollieInterval`, `FromMollieInterval` and the private `zonedParts`, `offsetAt`, `addDays`, `addMonths`, `daysInMonth`. |
| `src/implementations/subscriptions/mapping.ts` | `ToSubscription` through `boundsAt`, `steppedBounds` and `endingBefore` for the period, `trialEnd`, `interval`, `intervalCount` and `vendorData.interval`. Status, ending and metadata are not covered. |
| `src/test/calendar.properties.test.ts` | The properties, the seed, the run count, the finding record and its pinned test, and the generator coverage test. |
| `src/test/support/calendar-model.ts` | The oracle and the generators. |

`creation.ts` calls the covered functions and is not covered (see Bounds). A change that alters which date it passes to them needs this check read again.

After covered code changes, compare their behavior with the properties above and rerun the check. Move the synchronization commit forward only after confirming that the test still describes the new code.

Generator coverage at the default seed, over 300 sampled dates: 33 are 23-hour days, 29 are 25-hour days, 13 are February 29, 62 are the 30th or 31st ending their month, 145 are the 29th or later, and 29 are December 31. The 300 sampled periods are 79 days, 68 weeks, 81 months and 72 years, and 100 of them use the interval's longest count. `generates both daylight-saving days, February 29 and month ends` fails when a change to the generators loses one of these classes. `generates next payment dates on both sides of a clamped month end` fails when the generators draw no clamped next date, which would empty the finding, or no monthly date on the 29th or later that keeps the anchor's day, which would let `periodBoundsFromNextDate` pass without testing a month end.

## Findings

### `periodBoundsFromClampedNextDate`: a clamped next payment date starts its period on the clamped day

Found on the first run, at `6747973`, when the property covered every next payment date. A review then showed that a finding on the whole `nextPaymentDate` path hides every other break on it, so the property is split: `periodBoundsFromNextDate` holds on every date that is not a clamped month end, and this finding covers only the clamped ones. With seed `20261112` the finding fails on its first run that is not discarded, shrink path `21:0:3:5:5:5`, shrunk 5 times:

```text
[{"year":1996,"month":7,"day":31},{"interval":"month","count":1},11,0]
a period ending 1997-06-30 starts 1997-05-29T22:00:00.000Z, not 1997-05-30T22:00:00.000Z
```

The anchor is 1996-07-31 and the period is one month. The schedule's dates are `AddPeriods(anchor, month, n)`: 1997-05-31 for `n = 10` and 1997-06-30 for `n = 11`. Mollie reports `nextPaymentDate = 1997-06-30`. The module reads the period start as 1997-05-30 (local midnight, 1997-05-29T22:00Z), one day late, instead of 1997-05-31.

`endingBefore` in `mapping.ts` computes the start as `AddPeriods(DateOf(end), period, -1)`. That counts one month back from the clamped date, so it loses the anchor's day. `steppedBounds` counts forward from the anchor and gets it right. The two readings of one record disagree. The pinned test shows the smallest case through `ToSubscription`, with `now` on 2027-02-10:

```text
next=undefined start 2027-01-31 end 2027-02-28
next=2027-02-28 start 2027-01-28 end 2027-02-28
AddPeriods(2027-01-31, month, 1) = 2027-02-28
AddPeriods(2027-02-28, month, -1) = 2027-01-28
```

Reproduce with `pins periodBoundsFromClampedNextDate` in `src/test/calendar.properties.test.ts`. It asserts today's value and states the date it should be. It fails once the module is fixed, and that is the signal to turn the finding into `holds periodBoundsFromClampedNextDate` and delete the pin.

Scope: the period start of every month or year subscription whose anchor day is above 28 when Mollie reports the next payment date of a short month (a year with February 29 as the anchor too). It does not change what Mollie charges or when. It makes `currentPeriodStart` wrong by one to three days, so a consumer that computes a period length from it gets the wrong length. The documentation's "Month periods keep the anchor's day of the month and clamp to the last day" is what `AddPeriods` and `steppedBounds` do and `endingBefore` does not.

No fix is made in this pull request. The check lands with the finding recorded (`antelopejs-verify formal` rule 5, a new check passes with its recorded findings). The fix is a separate pull request: it changes `endingBefore` to step from the anchor, which changes covered behavior, so that pull request runs `formal` on the base, reports `periodBoundsFromClampedNextDate` as fixed and turns the finding into `holds`.

The fix must land before any other change to `calendar.ts` or `mapping.ts`. `antelopejs-verify formal` accepts a change to covered behavior with a violated rule only when the base run broke the same rule with the same counterexample length at HEAD. fast-check reports no honest counterexample length, so the `violation` regex in `verify.config.ts` has no `states` group and no length is recorded. While the finding stands, a later pull request that changes covered behavior, a harmless rename included, fails `formal` with "covered behaviour changed (…), violated periodBoundsFromClampedNextDate". A change that leaves the covered emit unchanged passes.

## Mutation evidence

Each scratch change below was applied to the current code, caught with the shrunk counterexample shown, and removed. The check then reported 12 passing again, the finding, its pinned test and the two generator tests included. `git diff --stat src/implementations` was empty afterward. Counterexamples are at the default seed. `pin` is the pinned test of the finding, which asserts today's clamped values and so also fails when a change moves them. `next` is `periodBoundsFromNextDate`, the property over the `nextPaymentDate` path that every active subscription takes.

| Scratch change | Properties that failed, first counterexample |
| --- | --- |
| `StartOf`: `utcMidnight - 3600000` for every date (`calendar.ts`) | `midnightIsLocal` `[828309600000]`, `dayLength` `[1996-03-31]`, `nextDateRounding` `[828230400000,0]`, `periodBoundsStepped` `[1996-01-01, day×31, 2, 0]`, `next` `[1996-03-31, day×1, 1, 0]` |
| `StartOf`: second read at `utcMidnight + 86400000` | `midnightIsLocal` `[828230400000]`, `dayLength` `[1996-03-31]`, `nextDateRounding` `[828223200000,0]`, `periodBoundsStepped` `[1996-03-31, day×1, 0, 0]`, `next` `[1996-03-31, day×1, 1, 0]`, `wireRoundTrip` `[day×1, 828223200001, 1996-12-31, 0]` |
| `StartOf`: one offset read instead of two | survives: equivalent mutant, see Bounds |
| `DateOf`: UTC date instead of Amsterdam date | `midnightIsLocal` `[828309600000]`, `nextDateRounding` `[828313200001,0]`, `next` `[1996-03-31, day×1, 1, 0]`, `wireRoundTrip` `[day×1, 4133977200001, 1996-02-29, 0]`, `pin` |
| `NextDateFrom`: `>` for `>=` | `nextDateRounding` `[828230400000,0]`, `wireRoundTrip` `[day×1, 846367200000, 1996-03-31, 0]` |
| `addMonths`: no clamp, `day: anchorDay` | `periodArithmetic` `[1996-01-31, month×1, 1]`, `periodBoundsStepped` `[1996-01-31, month×1, 0, 0]`, `next` `[1996-01-31, month×11, 3, 0]`, `pin` |
| `AddPeriods`: a year adds 1 month, not 12 | `periodArithmetic` `[1996-03-31, year×1, 1]`, `periodBoundsStepped` `[1996-03-31, year×1, 0, 0]`, `next` `[1996-03-31, year×1, 1, 0]`, `wireRoundTrip` `[year×1, 820454400000, 1996-02-29, 1]`, `pin` |
| `AddPeriods`: a week adds `count` days | `periodArithmetic` `[1996-12-31, week×1, 1]`, `periodBoundsStepped` `[1996-12-31, week×1, 0, 0]`, `next` `[1996-12-31, week×1, 1, 0]` |
| `ToMollieInterval`: `>=` for `>` against the limit | `unitLimits` `["week",52]`, `periodBoundsStepped` `[1996-03-31, day×365, 0, 0]`, `next` `[1996-03-31, day×365, 1, 0]`, `wireRoundTrip` `[day×365, 828230400000, 1996-01-01, 0]`, `pin` |
| `ToMollieInterval`: singular for 0, not 1 | `wireRoundTrip` `[week×1, 823046400000, 1996-12-31, 0]` |
| `FormatDate`: day padded to 1 digit | `wireRoundTrip` `[day×1, 820454400000, 1996-02-29, 0]` |
| `steppedBounds`: `<` for `<=` (`mapping.ts`) | `periodBoundsStepped` `[1996-01-31, day×1, 1, 0]` |
| `steppedBounds`: start of the next period (`mapping.ts`) | `dayLength` `[1996-03-31]`, `periodBoundsStepped` `[1996-03-31, day×1, 0, 0]`, `pin` |
| `boundsAt`: the next payment date ends at UTC midnight, `Date.UTC(d.year, d.month - 1, d.day)` for `StartOf(ParseDate(next))` (`mapping.ts`) | `next` `[1996-03-31, day×1, 1, 0]` |
| `endingBefore`: `{ interval, count: 1 }` for `periodOf(record)`, so the count is ignored (`mapping.ts`) | `next` `[1996-01-31, day×2, 1, 0]` |

A review found that the two last scratch changes passed all ten tests of the first version of this check, because the property over the `nextPaymentDate` path was a finding and a finding accepts any failure. `periodBoundsFromClampedNextDate` is a finding, so it has no mutation. Every property that holds fails under at least one scratch change.
