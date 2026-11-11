# Fixed findings of the metadata round trip check

Each entry is a finding the check recorded, the pull request that fixed it and what that fix stores.

## F1: `mergeKeepsForeignValue`, an early end erased a customer's metadata that is not an object

Fixed in #62. `MergeOwn` read metadata through `parse`, which turns anything that is not a JSON object, or a string holding one, into `{}`. So the first early end on a customer whose metadata was a string, a number or a list replaced it. `MergeOwn` now keeps such a value in the own record, under `kept`. `GetCustomer` reads no metadata for it before and after, as `ReadCallerMetadata` reads none from a value that is not an object. Other writers that read the value now find an object. That is the one-way door: Mollie keeps the value, but at a new place.

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
