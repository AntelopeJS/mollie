---
covers:
  - src/mollie/client.ts
  - src/mollie/errors.ts
docs:
  - README.md
  - docs/5.testing.md
journeys:
  - request-contract
  - sandbox-live
---

# Sandbox

What only the real Mollie can show: that the requests the client builds are accepted by Mollie's test mode.

## Sub-features

- `request-contract`: a payment request reaches the stand-in, which refuses any key but the configured one, and is accepted: the one leg of the contract a stand-in can check.
- `sandbox-live`: always NOT VERIFIED. No journey reaches Mollie's test mode: it needs the merchant's `test_` API key. A verdict that requires this feature therefore reads NOT VERIFIED, never PASS. The smoke feature leaves it out so a diff that touches no client code is judged on the stand-in journeys.

## How to get to it (user POV)

- A merchant who runs the module with a `test_` key.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" sandbox
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
