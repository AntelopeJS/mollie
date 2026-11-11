# Fixed findings of the metadata round trip check

Each entry is a finding the check recorded, the pull request that fixed it and what that fix stores.

## F1: `mergeKeepsForeignValue`, an early end erased a customer's metadata that is not an object

Fixed in #62. `MergeOwn` read metadata through `parse`, which turns anything that is not a JSON object, or a string holding one, into `{}`. So the first early end on a customer whose metadata was a string, a number or a list replaced it. `MergeOwn` now keeps such a value in the own record, under `kept`, a string as the string it is even when it holds a JSON object (the first version of the fix parsed it and wrote the object back, found in review). `ReadCallerMetadata` and `ReadOwn` read a kept string as they read it before the merge. `GetCustomer` reads the same metadata for it before and after. Other writers that read the value now find an object. That is the one-way door: Mollie keeps the value, but at a new place. The moved value and the `foreign` mark add bytes, so `RecordEarlyEnd` counts the merged metadata and rejects with a `SubscriptionError`, sending nothing, when it passes 1,024.

```text
Counterexample on c0f7ded: [[""],{"firstPayment":"tr_AAAAAAAAAA"}]
MergeOwn("crm-9", early end) = {"antelope":{"endedEarly":{"sub_corpusEnd02":[1779265800000,"4ad6bf3c"]}}}
```

`early-end-customer-metadata.test.ts` drives it through `CancelSubscription` and `GetCustomer` on the stand-in for a string, a number and a list. The `early-end-over-metadata-that-is-not-an-object` fixture holds the new shape.

## F2: `mergeKeepsForeignCallerView`, an early end changed what a customer created elsewhere read as

Fixed in #62. `ReadCallerMetadata` reads the nested `metadata` object only when the `antelope` key is present. Metadata another writer left with a `metadata` object of its own read as its string entries until the first early end added `antelope`. From then on it read as the nested object. `MergeOwn` now sets `foreign: true` in the own record it adds to such an object, and `ReadCallerMetadata` reads a record marked so as its string entries. A record merged before #62 carries no mark and still reads as the nested object, as the `early-end-over-a-metadata-object-another-writer-left` fixture holds.

```text
Counterexample on c0f7ded: [{["__proto__"]:"","metadata":{},"":{}},{"endedEarly":{}}]
caller view before {"crm":"c-9"} after {"plan":"gold"}   for {"crm":"c-9","metadata":{"plan":"gold"}}
```

## F4: `legacyEarlyEnd`, the first release's early end no longer read

Fixed in #61. `ef5dfaf` stored an early end as `{endedAt, endsAt, key}`. `eedbca1` changed it to `[endedAt, keyHash]`, and `toEarlyEnd` read only the list. A subscription ended early under `ef5dfaf` read as still running until its period end. The format lived 27 minutes on `main`, and no version reached npm.

```text
recorded: {"status":"canceled","cancelAtPeriodEnd":false,"endedAt":1779265800000, ...}
read before the fix: {"status":"active","cancelAtPeriodEnd":true,"endedAt":null, ...}
```

`toEarlyEnd` (`records.ts`) now also reads `{endedAt, key}` as an early end named by `KeyHash(key)`. The first release compared the raw key, today's code compares hashes, and the hash of the stored key matches the replay of the same key under both. The read writes nothing back. The fixture lost its `finding` mark, so `corpusReads` reads it, `holds legacyEarlyEnd` asserts the end, and `src/test/legacy-early-end.test.ts` replays `CancelSubscription` with the original key through the stand-in.

## F3: `ownSubscriptionValues`, a tampered interval count threw or hung a subscription read

Found when this check landed (#60) and fixed in the pull request that turned it into `holds ownSubscriptionValues`. `OWN_SUBSCRIPTION` checked `intervalCount` and `cancel.endsAt` with `IsCount`, which accepts any number. A subscription in its second period whose metadata said `"intervalCount":0` read as the module's, and `ToSubscription` threw `RangeError: Invalid time value`, so `GetSubscription` rejected, and so did `ListSubscriptions` for every subscription of that customer. With `-1`, `PeriodStartBefore` (`calendar.ts`) counted forward forever and blocked the event loop. A count stored as text, or an interval the interface does not know, hid a subscription Mollie still billed. A cancellation end past any date threw the same `RangeError` once Mollie cancelled the subscription. Anything holding the API key can write that metadata, the case `ReadOwn`'s TSDoc names.

```text
Counterexample: [{"antelope":{"reference":"antelope","createKey":" ","interval":"day","intervalCount":0,"start":"anchor"},"metadata":{}}]
intervalCount 0: threw Invalid time value
intervalCount -1: ToSubscription did not return within 3000 ms
```

`ReadOwnSubscription` now keeps the stored interval and count only when `IsBillablePeriod` (`calendar.ts`) accepts them: a whole count from 1 to the interval's longest. Otherwise it reads the period from Mollie's own `interval` through `FromMollieInterval`, the one Mollie bills, so the subscription still reads, lists and cancels. `FromMollieInterval` returns a period only for a form Mollie documents that `IsBillablePeriod` accepts. When neither period is readable, `ReadOwnSubscription` throws `UnreadablePeriodError`, a `SubscriptionError` naming the subscription: `GetSubscription`, `CancelSubscription` and a replay of the creation reject with it, `ListSubscriptions` leaves the subscription out, and `CreateSubscription` finds an earlier creation by its stored key through `CreateKeyOf` without reading the period. `cancel.endsAt` is checked with `IsInstant` (`guards.ts`), which accepts integers from 0 to the start of 31 December 9999 UTC, so an end past what the calendar can date drops the mark like any mistyped field. `AddPeriods` throws a `RangeError` for a count that is not a whole number of at least 1, so the calendar refuses such a count instead of looping. `src/test/tampered-period.test.ts` drives counts 0, -1, 1.5, `"2"` and 53, the interval `"fortnight"`, ends of `1e300`, `8.64e15`, `8.64e15 - 1` and one past the last day of 9999, and eight Mollie intervals Mollie does not document through `GetSubscription`, `ListSubscriptions`, `CancelSubscription` and `CreateSubscription` on the stand-in, under a watchdog worker that kills the run when the event loop stays blocked 10 s. Its `pins` test is gone.

A review of the first fix found two gaps. `IsInstant` accepted ends up to `8.64e15`, and an end of `8.64e15` or `8.64e15 - 1` on a subscription Mollie cancelled still threw `RangeError: Invalid time value` from every read and from `ListSubscriptions` for the whole customer. The fallback did not check Mollie's interval: `0 days` threw in the second period, `99999999999999999999 days` threw `Invalid time value`, `400 days` and `100 months` read past Mollie's maximums, and an unreadable one such as `3 fortnights` threw `RangeError` from every read and from `CreateSubscription` for that customer.
