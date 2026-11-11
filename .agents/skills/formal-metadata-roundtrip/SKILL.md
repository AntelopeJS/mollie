---
name: formal-metadata-roundtrip
description: Checks the Mollie metadata @antelopejs/mollie keeps, with fast-check properties and a golden corpus of every shape earlier versions wrote. It covers the caller's metadata and the module's own records reading back unchanged, merges keeping other writers' data, reads that never throw, metadata another writer left, metadata stored as JSON text, the sizes the docs promise fit Mollie's 1 kB, and backward compatibility since ef5dfaf. Use when a change touches mollie/metadata.ts, subscriptions/records.ts or shared/subscription-of-payment.ts, or changes what any writer stores in metadata.
---

# Check the metadata round trip

Run this check when a change touches the coverage record below, or changes what the module writes into Mollie metadata.

Everything the module keeps lives in Mollie, in the metadata of payments, refunds, captures, customers and subscriptions. `WriteMetadata` (`src/mollie/metadata.ts`) stores the module's own record under `antelope` and the caller's metadata under `metadata` next to it. `MergeOwn` later adds marks to the own record: `firstPayment`, `refused` and `cancel` on a subscription, `endedEarly` on a customer. A wrong read loses a reference, a replay key or an early end. A wrong merge erases data another writer left. A changed format orphans every record already written. Mollie returns metadata as JSON and documents "You can use up to approximately 1kB" (OpenAPI `metadata`, `github.com/mollie/openapi` at `10ce28b`).

## Run the check

From the repository root, with `MOLLIE_API_KEY` unset, run:

```sh
pnpm run build && pnpm exec ajs module test . -f dist/test/metadata.properties.test.js -f dist/test/metadata-corpus.test.js
```

`antelopejs-verify formal <run>` runs the same command. It takes about 5 s. The test uses fast-check 4.3.0, pinned as a devDependency. Each property in `metadata.properties.test.ts` requests 300 runs, and `keyedRoundTrip` and `foreignInterfaceView` 100. The default seed is `20261111`. Set `FC_SEED` to the integer a failure prints to replay another run, with the generators and the fast-check version unchanged. A failure prints the counterexample.

The corpus tests seed the stand-in's records directly, so they skip against Mollie's test mode. The properties run against either target.

Each check prints on its own line:

- `holds <name>` is a property that passes. A numbered `holds` line is a break.
- `finding <name>` is a recorded finding. It passes only while the property still fails, and fails with `<name> now holds: record it as holds` once a fix makes it hold.
- `pins <name>` holds the exact wrong behaviour of a finding on a named input, or the numbers of a bound's edge. A fix fails a finding's pin, and the fix PR deletes it.
- `generates` fails when a generator change loses a class of inputs the properties need.

## The properties

The model is `src/test/support/metadata-model.ts`. The expected values are the generated inputs themselves, or rules stated from the TSDoc and `docs/`. The model never computes an expected value with the module's readers. It uses the module's `IsJsonValue` only to check what `JSON.parse` returns, and calls `WriteMetadata` and `MergeOwn` only as the writers under test.

| Property | Source | What must hold | Result |
| --- | --- | --- | --- |
| `callerRoundTrip` | interface `metadata` "Round-tripped opaque key/value pairs" | For any caller metadata (keys `antelope`, `metadata`, `antelopeSubscription`, `__proto__` and empty included) next to any own record, the JSON round trip reads it back unchanged through `ReadCallerMetadata`, `ToPayment`, `ToRefund` and `ToSubscription`. Empty metadata reads as absent. | holds |
| `ownRoundTrip` | `ShownSubscription` TSDoc | An own subscription record reads back equal through `ReadOwnSubscription`. `ShownSubscription` returns it, except a refused one with no cancellation whose Mollie status is `canceled` or `completed`. A payment, a renewal and a first-period charge read back their reference, and a charge names its subscription through `SubscriptionOfPayment` without a request. | holds |
| `mergeKeepsForeignKeys` | `ReadOwn` TSDoc, `docs/4.subscriptions.md` "keeps it as it is" | Merging into a JSON object keeps every key but `antelope` as it was, keeps every own field the change does not name, and sets the ones it names. | holds |
| `mergeKeepsCallerView` | same | After a merge into metadata the module wrote, the caller reads the same metadata. | holds |
| `foreignCallerView` | interface `metadata` "Round-tripped opaque key/value pairs"; `ReadCallerMetadata` reads what another writer left | Metadata with no `antelope` key (an object of any keys, one with a `metadata` object of its own, or the text of either) reads as its own string entries through `ReadCallerMetadata`, `ToPayment`, `ToRefund` and `ToSubscription`, and is not the module's. | holds |
| `mergeKeepsForeignCallerView` | same | After a merge into another writer's JSON object, the caller still reads its string entries. | finding F2 |
| `mergeKeepsForeignValue` | same; Mollie's `metadata` takes a string, a number, an object or a list of strings | A merge into metadata that is not a JSON object keeps that value. | finding F1 |
| `readsNeverThrow` | `ReadOwn` TSDoc: "a field of another type is dropped" | For any JSON, including well-formed own records with one field of another type and cancellation marks with a valid key and one field of another type or an unknown timing, every reader returns its documented types without throwing. `AssertOwnTypes` (`support/metadata-types.ts`) checks every field of the own subscription it returns, `cancel.timing` included. Metadata with no own object reads as not the module's: no own subscription, an empty reference, no charged subscription. | holds |
| `textRoundTrip` | `parse` in `metadata.ts`, unchanged since `ef5dfaf`; no TSDoc or doc states it | Metadata Mollie holds as the JSON text of what the module wrote reads as the object it holds: the caller's metadata, an own subscription record, a payment's reference and a charge's subscription. | holds |
| `textWithoutObject` | same | A metadata string that is not the JSON text of an object (JSON of another type, or text that is not JSON) reads as no caller metadata, no own subscription, an empty reference and no charged subscription. | holds |
| `ownSubscriptionValues` | same, and the interval table of `docs/4.subscriptions.md` | An own subscription record the module accepts has values it could have written: an integer count from 1 to the interval's longest, and a cancellation end that is a non-negative integer. | holds (F3 fixed) |
| `laterWritesFit` | `docs/4.subscriptions.md` "Metadata": about 1 kB per subscription, an own record of up to about 400 bytes, about 600 bytes for the caller's `metadata` | Caller metadata of at most 600 bytes (the JSON text, padded to exactly 600 half the time) next to an own record of at most 400 bytes stays within 1,024 bytes after the first charge or the refusal and then a cancellation now or at the period end. Nothing beyond the budget is generated. | holds |
| `earlyEndsFit` | `docs/4.subscriptions.md` "Cancelling": "room for about twenty" early ends | Twenty early ends fit a customer with no other metadata. | holds |
| `corpusReads` | the golden corpus | Every shape written since `ef5dfaf` reads through the interfaces as the version that wrote it read it. | holds |
| `legacyEarlyEnd` | the golden corpus | The first release's early end ends its subscription early. | holds |
| `corpusCoversWriters` | the golden corpus | Every record today's writers write has the format of a fixture still written (`until: null`). | holds |
| `foreignInterfaceView` | same as `foreignCallerView` | `GetPayment` and `GetCustomer` on the stand-in read another writer's metadata, with no `antelope` key, as its string entries (an object, one with a `metadata` object of its own, or the text of either). | holds |
| `keyedRoundTrip` | `docs/2.payments.md` replays, `docs/4.subscriptions.md` early ends | A refund, a capture and an early end stored under any key replay under that key, and the early end's hash names the same request. | holds |

## The golden corpus

`src/test/fixtures/metadata-corpus-payments.json` and `metadata-corpus-subscriptions.json` hold one fixture per stored shape. Each names `since`, the first commit that wrote it, `until`, the first commit that stopped (`null` while it is still written), and its `writer`. `seed` holds the records as Mollie would hold them, under fixed ids. `reads` holds what the version that wrote them read back. `ReadFixture` (`src/test/support/metadata-corpus.ts`) seeds the stand-in and reads through `GetPayment`, `GetRefund`, `GetCustomer` and `GetSubscription`. It also replays `RefundPayment` and `CapturePayment` under the stored key, or under an unknown key when none is stored, on a payment whose state refuses a new refund or capture. So only a replay resolves.

The shapes come from `git log -p` of `src/mollie/metadata.ts`, `src/implementations/subscriptions/records.ts` and every `WriteMetadata` and `MergeOwn` caller, from `ef5dfaf` to `c0f7ded`.

- `ef5dfaf` wrote a payment `{reference}`, a first-period charge `{reference, subscription}`, a refund with `{}` or `{reason}`, a capture with no metadata, a customer `{}`, an early end as `{endedAt, endsAt, key}`, and a subscription `{reference, createKey, interval, intervalCount, start}` with `firstPayment`, `refused` and `cancel` merged in later.
- `eedbca1`, 27 minutes later, added `key` to refunds and `{key}` to captures, and stored an early end as `[endedAt, keyHash]`, the first 8 hex digits of the key's SHA-256. It also kept a customer's foreign top-level keys visible. The reader has accepted the first release's object again since the fix of F4: it reads `{endedAt, key}` as an early end whose hash is the key's.
- `c8e56ae` shows a refused subscription the caller cancelled, so `refused` with `cancel` is a shape the interface reads.
- `82a6eee`, `b1b17af`, `f5c6543`, `4266686`, `5d48627`, `2bf8046`, `8799bff` and `c0f7ded` changed how records are read and when marks are written, not the stored shapes.

A writer change that stores a new format fails `corpusCoversWriters` and names the step. Add a fixture for the new format with `since` set to that change and `until` on the one it replaces. Never edit the `metadata` of an existing fixture: it is what Mollie holds for some merchant. A change that alters a fixture's `reads` on purpose updates `docs/` and says so.

## Judge the result

1. Read the shrunk counterexample. Most are `[metadata, ...]` or `[own record, caller metadata, ...]`. A corpus failure prints the fixture's name, its `since` and what it read.
2. Replay it through the named public function, or through the interface on the stand-in, before you judge. A failure in `metadata-model.ts` or `metadata-corpus.ts` is an oracle error until that replay shows the module wrong.
3. A failing property is a product finding. Report the counterexample before you propose a fix, exclude inputs, skip the property or loosen the model. Do not fix covered code in the pull request that adds or changes this check: `antelopejs-verify formal` fails a new check that lands with a covered-code change.
4. Fix a finding in its own pull request. Rename its `finding` to `holds`, delete its `pins` test, and move it under Fixed below. `formal` then reports it fixed against the base. A finding recorded as a fixture (`legacyEarlyEnd`) leaves the fixtures' `finding` field and the `finding` test of `metadata-corpus.test.ts` when it is fixed: add them back with the next such finding.

## Bounds and exclusions

This is randomized testing of real code, not an exhaustive proof. It does not cover:

- What Mollie does with metadata beyond a JSON round trip. Whether it keeps key order, accepts NUL or lone surrogates, counts its 1 kB in bytes or characters, and refuses or truncates above it is not observed. The stand-in enforces no size. `laterWritesFit` counts UTF-8 bytes of the JSON text.
- Subscription metadata past the documented budget. The module checks no size at creation, then adds `firstPayment` (31 bytes) and a cancellation mark (35 bytes plus the key for `now`, 65 plus the key at the period end). A subscription Mollie accepted at 1,024 bytes grows to 1,055 with the first charge and 1,128 with a cancellation at the period end, and the cancellation PATCH that `cancelAtPeriodEnd` sends before its DELETE may then fail. `docs/4.subscriptions.md` says Mollie does not document what it does beyond the budget, so this is a bound, not a finding, until Mollie's behaviour is observed.
- The one byte past 1,024 at the budget's joint edge. 400 own bytes, 600 caller bytes and the 25 bytes of the two wrapper keys make 1,025. The widest keys make an own record of 398 bytes and 1,023 in all (`pins laterWritesFit`). The docs say "about", so the byte is not asserted.
- Inputs the interfaces never pass: caller metadata values that are not strings, and own records the module never writes, such as `firstPayment` with `refused`. The generators produce such combinations anyway, as a superset.
- Two writers merging into the same metadata at once. `formal-subscription-lifecycle` owns that race.
- Period bounds. The corpus asserts status, end and the marks, not `currentPeriodStart` or `currentPeriodEnd`. `formal-amsterdam-calendar` owns those.
- `CreateCheckoutSession`. `checkout.ts` writes the payment format through the same `WriteMetadata` call as `CreatePayment`, and `corpusCoversWriters` does not drive it.
- The customer's early ends past Mollie's limit. One early end adds 43 bytes, each later one 44, so 22 fit a customer with no other metadata (1,011 bytes) and the 23rd makes 1,055. `docs/4.subscriptions.md` documents this, so it is a bound, not a finding. `earlyEndsFit` asserts the documented twenty.
- Metadata the module writes as a string. It writes objects only. `textRoundTrip` and `textWithoutObject` cover JSON text another writer left.
- Long references and keys. With an empty reference and empty keys, the largest own subscription record is 183 bytes, and the whole metadata with no caller entries 210. The 400 bytes `docs/4.subscriptions.md` gives the own record hold while the reference, the creation key and the cancellation key add up to at most 217 bytes.

## Coverage record

Last code synchronization is `c0f7ded`.

| File | Covered functions and role |
| --- | --- |
| `src/mollie/metadata.ts` | `WriteMetadata`, `MergeOwn`, `ReadOwn`, `ReadCallerMetadata` and the private `parse` (its JSON-text reading included) and `strings`. |
| `src/implementations/subscriptions/records.ts` | `ReadOwnSubscription` (its fallback to Mollie's interval included), `ShownSubscription`, `KeyHash`, the `OWN_SUBSCRIPTION` and `OWN_CUSTOMER` guards, and through the interface `endedEarly`, `toEarlyEnd` (both stored shapes), `earlyEndOf` and `RecordEarlyEnd`. |
| `src/implementations/shared/subscription-of-payment.ts` | `SubscriptionOfPayment` and its two guards. |
| Writers, through `corpusCoversWriters` | `PaymentBody`, `CapturePayment` (`payments.ts`), `RefundPayment` (`refunds.ts`), `CreateCustomer` (`customers.ts`), `subscriptionBody`, `chargeFirstPeriod`, `updateOwn` (`creation.ts`), `cancelAtMollie` (`changes.ts`). These files are not in `covers`, so `formal` does not run this check for them, but `pnpm test` does. |
| Readers, through the interface | `ToPayment`, `ToRefund` (`payment/mapping.ts`), `ToSubscription` (`subscriptions/mapping.ts`), refund and capture replays. |

After covered code changes, compare its behaviour with the properties above and rerun the check. Move the synchronization commit forward only after confirming that the test still describes the new code.

Generator coverage at the default seed, over 300 samples each:

- Caller metadata has `antelope` as a key 22 times, `metadata` 30, `antelopeSubscription` 26, `__proto__` 37, `ANTELOPE` 33, `" spaced key "` 38 and the empty key 62, and is empty 49 times.
- Arbitrary metadata is the module's 129 times, holds a foreign value under `antelope` 22 times, is another object 53 times, a string 56 times (24 of them a JSON object), a number 16 times, a list 18 times, and `true`, `false` or `null` 6 times.
- It holds a cancellation mark 75 times: 11 with a valid key and an unknown timing, 6 with a key of another type, 23 with an end of another type.
- Metadata another writer left has a `metadata` object of its own 149 times and is JSON text 138 times, and 71 nested objects hold a string entry. 209 non-object texts are JSON of another type.
- The caller metadata of `laterWritesFit` is exactly 600 bytes 105 times and never more.
- Own records are 43 payments, 45 charges, 49 captures, 44 refunds, 79 customers and 40 subscriptions.
- Tampered subscription records have a count of 0 or less 151 times and a non-integer count 82 times.

## Findings

Two findings stand, F1 and F2. F3 and F4 are fixed, under Fixed below. Counterexamples are at seed `20261111`.

### F1: `mergeKeepsForeignValue`, an early end erases a customer's metadata that is not an object

`MergeOwn` reads metadata through `parse`, which turns anything that is not a JSON object, or a string holding one, into `{}`. So the first early end on a customer whose metadata is a string, a number or a list replaces it. `docs/4.subscriptions.md` says the customer's metadata is kept "as it is". A customer created outside the module, by the dashboard or another plugin, can hold such metadata. Mollie's specification allows it.

```text
Counterexample: [[""],{"firstPayment":"tr_AAAAAAAAAA"}]
MergeOwn("crm-9", early end) = {"antelope":{"endedEarly":{"sub_corpusEnd02":[1779265800000,"4ad6bf3c"]}}}
```

`pins mergeKeepsForeignValue` reproduces it through `CancelSubscription` on the stand-in: a customer whose metadata is `"crm-9"` holds no `crm-9` after an early end.

### F2: `mergeKeepsForeignCallerView`, an early end changes what a customer created elsewhere reads as

`ReadCallerMetadata` reads the nested `metadata` object only when the `antelope` key is present. Metadata another writer left with a `metadata` object of its own reads as its string entries until the first early end adds `antelope`. From then on it reads as the nested object.

```text
Counterexample: [{["__proto__"]:"","metadata":{},"":{}},{"endedEarly":{}}]
caller view before {"crm":"c-9"} after {"plan":"gold"}   for {"crm":"c-9","metadata":{"plan":"gold"}}
```

`pins mergeKeepsForeignCallerView` reproduces the second line through `GetCustomer`.

## Fixed

### F4: `legacyEarlyEnd`, the first release's early end no longer read

`ef5dfaf` stored an early end as `{endedAt, endsAt, key}`. `eedbca1` changed it to `[endedAt, keyHash]`, and `toEarlyEnd` read only the list. A subscription ended early under `ef5dfaf` read as still running until its period end. The format lived 27 minutes on `main`, and no version reached npm.

```text
recorded: {"status":"canceled","cancelAtPeriodEnd":false,"endedAt":1779265800000, ...}
read before the fix: {"status":"active","cancelAtPeriodEnd":true,"endedAt":null, ...}
```

`toEarlyEnd` (`records.ts`) now also reads `{endedAt, key}` as an early end named by `KeyHash(key)`. The first release compared the raw key, today's code compares hashes, and the hash of the stored key matches the replay of the same key under both. The read writes nothing back. The fixture lost its `finding` mark, so `corpusReads` reads it, `holds legacyEarlyEnd` asserts the end, and `src/test/legacy-early-end.test.ts` replays `CancelSubscription` with the original key through the stand-in.

### F3: `ownSubscriptionValues`, a tampered interval count threw or hung a subscription read

Found when this check landed (#60) and fixed in the pull request that turned it into `holds ownSubscriptionValues`. `OWN_SUBSCRIPTION` checked `intervalCount` and `cancel.endsAt` with `IsCount`, which accepts any number. A subscription in its second period whose metadata said `"intervalCount":0` read as the module's, and `ToSubscription` threw `RangeError: Invalid time value`, so `GetSubscription` rejected, and so did `ListSubscriptions` for every subscription of that customer. With `-1`, `PeriodStartBefore` (`calendar.ts`) counted forward forever and blocked the event loop. A count stored as text, or an interval the interface does not know, hid a subscription Mollie still billed. A cancellation end past any date threw the same `RangeError` once Mollie cancelled the subscription. Anything holding the API key can write that metadata, the case `ReadOwn`'s TSDoc names.

```text
Counterexample: [{"antelope":{"reference":"antelope","createKey":" ","interval":"day","intervalCount":0,"start":"anchor"},"metadata":{}}]
intervalCount 0: threw Invalid time value
intervalCount -1: ToSubscription did not return within 3000 ms
```

`ReadOwnSubscription` now keeps the stored interval and count only when `IsBillablePeriod` (`calendar.ts`) accepts them: a whole count from 1 to the interval's longest. Otherwise it reads the period from Mollie's own `interval` through `FromMollieInterval`, the one Mollie bills, so the subscription still reads, lists and cancels. `cancel.endsAt` is checked with `IsInstant` (`guards.ts`), so an end a `Date` cannot hold drops the mark like any mistyped field. `AddPeriods` throws a `RangeError` for a count that is not a whole number of at least 1, so the calendar refuses such a count instead of looping. `src/test/tampered-period.test.ts` drives counts 0, -1, 1.5, `"2"` and 53, the interval `"fortnight"` and an end of `1e300` through `GetSubscription`, `ListSubscriptions` and `CancelSubscription` on the stand-in, under a watchdog worker that kills the run when the event loop stays blocked 10 s. Its `pins` test is gone.

## Mutation evidence

`MUTATIONS.md` lists the scratch changes the check was run against and the checks that fail under each. Add a row there when a review finds a change the holding checks miss.
