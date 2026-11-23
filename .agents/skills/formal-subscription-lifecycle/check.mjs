#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSpec, EXIT } from "@antelopejs/tooling-configs/formal";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Rules main breaks in the creation spec, with the states in TLC's shortest counterexample. */
const CREATION_FINDINGS = {};

/** Rules main breaks in the cancellation spec. */
const CANCELLATION_FINDINGS = {};

/** The findings of each spec under each configuration, in run order. */
const SPECS = {
  SubscriptionCreation: {
    ci: CREATION_FINDINGS,
    full: CREATION_FINDINGS,
  },
  SubscriptionCancellation: {
    ci: CANCELLATION_FINDINGS,
    full: CANCELLATION_FINDINGS,
  },
};

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--full")) {
  console.error("usage: node check.mjs [--full]");
  process.exit(EXIT.tool);
}
const mode = args.includes("--full") ? "full" : "ci";

for (const [spec, findings] of Object.entries(SPECS)) {
  await checkSpec({ dir, spec, config: mode === "full" ? spec : `${spec}.ci`, findings: findings[mode] });
}
