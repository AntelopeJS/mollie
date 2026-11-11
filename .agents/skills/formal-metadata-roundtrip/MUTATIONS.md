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

M17 to M19 survived the first version: dropping the guard failed only a pin, a cancellation timing of any string passed `readsNeverThrow`, and no property asserted that a string is parsed. The generators then gained foreign metadata with a `metadata` object of its own and as JSON text, cancellation marks with a valid key and one bad field, and `textRoundTrip` and `textWithoutObject`, and `AssertOwnTypes` gained the cancellation mark. M20 shows that `laterWritesFit` and `earlyEndsFit` can fail at all. M7 and M13 first survived. The generators then gained a well-formed own record with one mistyped field, and keys with edge spaces or another case, and `keyedRoundTrip` went from 40 to 100 runs. Both are now caught.
