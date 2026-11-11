# Mutation evidence for the metadata round trip check

Each scratch change below was applied to the current code, rebuilt, run with both test files, and reverted. `git diff --stat src/implementations src/mollie` was empty afterward. Every holding property fails under at least one change. The table leaves out the finding and pin tests a change also flips.

| # | Scratch change | Failed checks, first counterexample |
| --- | --- | --- |
| M1 | `ReadCallerMetadata` reads `strings(parsed)` instead of the nested caller object | `callerRoundTrip` `[refund {key:" "}, {"":""}]`, `mergeKeepsCallerView`, `corpusReads`, `keyedRoundTrip` |
| M2 | `WriteMetadata` also spreads the caller's keys at the top level | `callerRoundTrip` `[refund {key:"antelope"}, {metadata:"antelope", antelope:"antelope"}]`, `ownRoundTrip`, `mergeKeepsCallerView`, `corpusCoversWriters`, `keyedRoundTrip` |
| M3 | `MergeOwn` replaces the own record with the changes | `mergeKeepsForeignKeys` `[{"":[], antelope:{"":[]}}, {firstPayment}]`, `corpusCoversWriters` |
| M4 | `MergeOwn` keeps only `antelope` and `metadata` | `mergeKeepsForeignKeys` `[{"":[], antelope:false}, {firstPayment}]` |
| M5 | `MergeOwn` empties the caller object | `mergeKeepsForeignKeys`, `mergeKeepsCallerView` `[refund {key:" "}, {"":""}, {refused}]`, `keyedRoundTrip` |
| M6 | `parse` lets a `JSON.parse` error out | `readsNeverThrow` `["antelope", "pending"]` |
| M7 | `OWN_SUBSCRIPTION.intervalCount` accepts any defined value | `readsNeverThrow` with `intervalCount: []` |
| M8 | `ToPayment` reports `"unknown"` for a payment that is not the module's | `readsNeverThrow` `[{"":[]}, "pending"]` |
| M9 | `ShownSubscription` shows a refused subscription Mollie ended | `ownRoundTrip` with `refused` and status `completed`, `corpusReads` |
| M10 | `ShownSubscription` hides a refused subscription the caller cancelled | `ownRoundTrip` with `refused`, `cancel` and status `completed`, `corpusReads` |
| M11 | an early end is read only from a three-item list | `corpusReads`, `keyedRoundTrip` `["\u0000", {}, 0]` |
| M12 | `KEY_HASH_LENGTH` is 10 | `keyedRoundTrip` `["\u0000", {}, 0]` |
| M13 | a refund replay trims the key it looks for | `keyedRoundTrip` `[" spaced key ", {}, 0]` |
| M14 | a capture replay lowercases the key it looks for | `keyedRoundTrip` `["toString", {}, 0]` |
| M15 | a first-period charge names its subscription only when Mollie spawned it | `ownRoundTrip`, `corpusReads` |
| M16 | `PaymentBody`'s own record gains `version: 2` | `corpusCoversWriters` |
| M17 | `ReadCallerMetadata` drops the `OWN_KEY in parsed` guard and reads a nested `metadata` object whenever there is one | `foreignCallerView` `["{\"\":[],\"metadata\":{\"\":\"antelope\"}}"]`, `foreignInterfaceView` |
| M18 | `OWN_SUBSCRIPTION.cancel.timing` accepts any string | `readsNeverThrow` `[{antelope:{…,cancel:{timing:"NOW",key:" ",endsAt:0}},metadata:{}}, "pending"]` |
| M19 | `parse` parses a metadata string and then returns `{}` | `textRoundTrip` `[{reference:"\u0000",…},{},["\u0000","antelope"]]`, `foreignCallerView` and `foreignInterfaceView` `["{\"\":\"\"}"]` |
| M20 | `MergeOwn` also writes a 120-byte `modifiedBy` field | `laterWritesFit` (a 600-byte caller and widest keys), `earlyEndsFit`, `mergeKeepsForeignKeys`, `corpusCoversWriters` |
| M21 | `toEarlyEnd` ignores the first release's `{endedAt, key}` object (the code before the F4 fix) | `corpusReads`, `legacyEarlyEnd`, and both tests of `legacy-early-end.test.ts` |
| M22 | `toEarlyEnd` keeps the first release's `key` unhashed as the key hash | the replay test of `legacy-early-end.test.ts` alone: no property replays a subscription cancellation under a stored key |
| M23 | `ReadOwnSubscription` keeps any stored interval count, as before the F3 fix | `ownSubscriptionValues` `[{antelope:{…,interval:"day",intervalCount:0,start:"anchor"},metadata:{}}]` |
| M24 | `OWN_SUBSCRIPTION.cancel.endsAt` accepts any number, as before the F3 fix | `ownSubscriptionValues` `[{antelope:{…,cancel:{timing:"now",key:"\u0000",endsAt:-5e-324}},metadata:{}}]` |
| M25 | `IsInstant` accepts integers up to `8.64e15`, as before the F3 review | `ownSubscriptionValues`, and the three stand-in tests of `tampered-period.test.ts` for ends of `8.64e15`, `8.64e15 - 1` and one past the last day of 9999 |
| M26 | `FromMollieInterval` returns any period it parses, without `IsBillablePeriod` | `ownSubscriptionValues`, and the stand-in tests of `tampered-period.test.ts` for `0 days`, `00 weeks`, `99999999999999999999 days`, `400 days` and `100 months` |
| M27 | `ListSubscriptions` lets `UnreadablePeriodError` fail the whole list | the eight stand-in tests of `tampered-period.test.ts` for intervals Mollie does not document. No property lists subscriptions |
| M28 | `CreateSubscription` reads the period to find an earlier creation and skips a subscription whose period cannot be read | the same eight stand-in tests: the replay two hours later posts a second subscription, which the stand-in refuses as a duplicate description, not with the error naming the first. No property replays a creation |
| M29 | `MergeOwn` drops metadata that is not an object instead of keeping it under `kept` | `mergeKeepsForeignValue` `[[""], {firstPayment}]`, the string, number and list cases of `early-end-customer-metadata.test.ts` |
| M30 | `MergeOwn` never marks another writer's object `foreign` | `mergeKeepsForeignKeys` `[{metadata:{}}, {refused}]`, `mergeKeepsForeignCallerView` `[{"__proto__":"",metadata:{},"":{}}, {endedEarly:{}}]`, the nested-object case of `early-end-customer-metadata.test.ts` |
| M31 | `ReadCallerMetadata` ignores the `foreign` mark | `mergeKeepsForeignCallerView`, `corpusReads`, the nested-object case of `early-end-customer-metadata.test.ts` |
| M32 | `MergeOwn` marks every object holding a `metadata` object, the module's own included | `mergeKeepsForeignKeys`, `mergeKeepsCallerView` `[refund {key:" "}, {"":""}, {refused}]`, `laterWritesFit`, `keyedRoundTrip`, `corpusCoversWriters`, the case of `early-end-customer-metadata.test.ts` already carrying `antelope` |
| M33 | `MergeOwn` wraps metadata that is not an object under `metadata` instead of `kept` | `mergeKeepsForeignValue` `["antelope", {refused}]`, the string case of `early-end-customer-metadata.test.ts` |

M17 to M19 survived the first version: dropping the guard failed only a pin, a cancellation timing of any string passed `readsNeverThrow`, and no property asserted that a string is parsed. The generators then gained foreign metadata with a `metadata` object of its own and as JSON text, cancellation marks with a valid key and one bad field, and `textRoundTrip` and `textWithoutObject`, and `AssertOwnTypes` gained the cancellation mark. M20 shows that `laterWritesFit` and `earlyEndsFit` can fail at all. M7 and M13 first survived. The generators then gained a well-formed own record with one mistyped field, and keys with edge spaces or another case, and `keyedRoundTrip` went from 40 to 100 runs. Both are now caught.

M23 and M24 each put back half of the code before the F3 fix. M24 also fails the stand-in test in `src/test/tampered-period.test.ts` for a cancellation end of `1e300`, with `RangeError: Invalid time value`. M25 and M26 put back the two gaps the review of that fix found.

M17 to M19 survived the first version: dropping the guard failed only a pin, a cancellation timing of any string passed `readsNeverThrow`, and no property asserted that a string is parsed. The generators then gained foreign metadata with a `metadata` object of its own and as JSON text, cancellation marks with a valid key and one bad field, and `textRoundTrip` and `textWithoutObject`, and `AssertOwnTypes` gained the cancellation mark. M20 shows that `laterWritesFit` and `earlyEndsFit` can fail at all. M7 and M13 first survived. The generators then gained a well-formed own record with one mistyped field, and keys with edge spaces or another case, and `keyedRoundTrip` went from 40 to 100 runs. Both are now caught. M21 to M31 were run against the fix of F1 and F2 in #62: each fails at least one check. M31 fails only on a string, as a wrapped number or list holds no string entry the caller would read.
