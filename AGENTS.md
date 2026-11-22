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
- With `MOLLIE_API_KEY` unset, `pnpm run checks` runs the suites against the stand-in. To run them against Mollie's test mode, set `MOLLIE_API_KEY` to a `test_…` key, and `MOLLIE_SECOND_API_KEY` to a second test account for the multi-account tests, then run `pnpm test`. The suite refuses `live_…` keys.
- Every behaviour the stand-in models is listed with its source in `src/test/stand-in/SOURCES.md`. Update it when you change the stand-in.

## Shipped files

- `docs/` and `skills/` ship in the npm package. `skills/` reaches users through `antelopeJs.skills`; when behaviour changes, update `README.md`, `docs/` and `skills/mollie/SKILL.md` together.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

CI runs `pnpm run checks` in full on every pull request and reports what failed. The commit hook formats and lints the staged files. Locally, run only the fast check for what you touched:

- `pnpm run typecheck` after you change types or signatures.
- `pnpm exec oxlint <files>` and `pnpm exec oxfmt <files>` on the files you changed.
- One test file, not the suite. In a module that tests with `ajs module test`: `pnpm run build`, then `pnpm exec ajs module test . -f dist/<path>.test.js`.

### Comments

Say it in code: a constraint in a type, a lint rule or a test, a public item's contract in TSDoc. Other comments are lint directives naming their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, and license or tool directives. A reason states what the code does now.

### Tests

Each test names the wrong implementation it fails on, or is deleted. Drive behaviour through the public interface. An invariant over many files is a lint rule.

### Review

No tool checks these:

- A type guard checks the nested elements and values it claims.
- A no-upward import rule rejects same-tier peers; probe it with an import.
- A finding only an evasion or a patched internal can trigger goes under Attention and never blocks.

### Suppressions

`guardrails.suppressions.json` caps lint directives, `@ts-expect-error`, `SAFETY:` comments and rules a lint config turns off. Over a cap, fix the code or remove another suppression of that kind; only the operator raises a number. After removing suppressions, run `pnpm run suppressions:update` and commit the file.

<!-- antelopejs-guardrails:end -->
