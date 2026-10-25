# mollie

The AntelopeJS Mollie module, published as `@antelopejs/mollie`. It implements `@antelopejs/interface-payment` and `@antelopejs/interface-subscriptions` on Mollie's API.

## Layout

- `src/index.ts`: the module's `construct`/`destroy` and its `Config`. It registers each configured account (`src/accounts.ts`) and implements both interfaces.
- `src/mollie/`: the HTTP client for Mollie's v2 API, amounts, and errors.
- `src/implementations/payment/` and `src/implementations/subscriptions/`: the two interface implementations; `shared/` holds what both use.
- `src/test/`: the test config (`antelope.test.ts`), the suites, `support/` (harness, test payer, target selection) and `stand-in/`, a local server that answers the part of Mollie's API the module uses.

## Versioning

- `@antelopejs/interface-payment` and `@antelopejs/interface-subscriptions` come from npm. Do not point them at git through `pnpm.overrides`: CI has no SSH key, and a git-hosted interface is built by a nested `pnpm install` of its own devDependencies, which the overrides do not reach. When you raise an interface's range, update the code, `docs/` and `skills/mollie/SKILL.md` with it.

## Tests

- `pnpm test` builds `dist`, then runs `ajs module test .` (`ajs` comes from the `@antelopejs/core` devDependency). `src/test/antelope.test.ts` starts the stand-in and runs the compiled suites in `dist/test`: the interface conformance suites and this module's own tests. The conformance tests Mollie cannot pass are reported pending by name; `docs/5.testing.md` lists them.
- `pnpm run checks` runs the suites against the stand-in only. To run them against Mollie's test mode, set `MOLLIE_API_KEY` to a `test_…` key, and `MOLLIE_SECOND_API_KEY` to a second test account for the multi-account tests, then run `pnpm test`. The suite refuses `live_…` keys.
- Every behaviour the stand-in models is listed with its source in `src/test/stand-in/SOURCES.md`. Update it when you change the stand-in.

## Shipped files

- `docs/` and `skills/` ship in the npm package. `skills/` reaches users through `antelopeJs.skills`; when behaviour changes, update `README.md`, `docs/` and `skills/mollie/SKILL.md` together.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

Finish every change with `pnpm run checks`. It runs typecheck, lint, format, knip, tests, size, ratchet, and sync, and prints only what failed. The change is done when it prints no failure.

The tools enforce most rules, listed in the table at the end. The sections below hold the rules no tool checks.

### Comments

Say it in code. A constraint belongs in a type, a lint rule, or a test. A public item's contract belongs in TSDoc (`/** */`) on that item. The only other comments are lint directives that name their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, `/*!` license headers, and bundler or formatter directives.

### Tests

Hold every test you write or keep to this checklist:

- Name the wrong implementation this test fails on. A test with no answer is deleted, not kept.
- No test reads the file it tests. Drive the behaviour through the public interface.
- An invariant over many files is a lint rule, not a test.

### Debt

`guardrails.ratchet.json` records the lint findings and oversize files this repository already had. Its numbers only go down. After you remove debt, run `pnpm run ratchet:update` and commit the lowered file. A rule listed there is off for `oxlint`. The ratchet counts it instead, and the pre-commit hook rejects it on every line you add.

### What enforces what

| Rule                                                                           | Enforced by                               |
| ------------------------------------------------------------------------------ | ----------------------------------------- |
| Formatting                                                                     | oxfmt                                     |
| Lint findings are errors; no rule warns                                        | oxlint preset                             |
| Comments are TSDoc, directives, or `SAFETY:` only                              | `antelopejs/no-comments`                  |
| Every test asserts                                                             | `antelopejs/require-assertion`            |
| Tests read no files outside fixtures, helpers, locales                         | `antelopejs/no-fs-read-in-tests`          |
| No assertion that restates a constant                                          | `antelopejs/no-constant-value-assertion`  |
| No test whose only check is "is a function"                                    | `antelopejs/no-typeof-function-only-test` |
| Params ≤ 5, function ≤ 120 lines, file ≤ 500 lines, depth ≤ 4, complexity ≤ 20 | `eslint/max-*`, `eslint/complexity`       |
| Files ≤ 20,000 bytes, tests included                                           | `antelopejs-check-size` (pre-commit)      |
| Existing debt only shrinks                                                     | `antelopejs-ratchet`                      |
| Types check                                                                    | `tsc` (pre-push)                          |
| No dead files, exports, or dependencies                                        | knip                                      |
| Managed files match the pack                                                   | `antelopejs-sync --check`                 |
| A test names the wrong implementation it catches                               | review; no tool                           |

<!-- antelopejs-guardrails:end -->
