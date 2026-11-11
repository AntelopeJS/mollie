import assert from "node:assert/strict";

import { GetAccount } from "../accounts";
import { type Config, construct } from "../index";
import { CurrentHarness } from "./support/harness";

const MALFORMED_SETTLE_TIMEOUTS: [string, unknown][] = [
  ["a string", "5"],
  ["a negative number", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a fraction of a millisecond", 1500.5],
  ["more than a Node timer holds", 2_147_483_648],
  ["more than a timeout signal takes", 5_000_000_000],
];

describe("[mollie] configuration", () => {
  for (const [name, value] of MALFORMED_SETTLE_TIMEOUTS) {
    it(`refuses to start with ${name} as settleTimeoutMs, and registers no account`, async () => {
      const before = GetAccount();
      const config: Config = {
        apiKey: CurrentHarness().target.apiKey,
        apiUrl: CurrentHarness().apiUrl,
      };
      Reflect.set(config, "settleTimeoutMs", value);
      await assert.rejects(construct(config), /settleTimeoutMs/);
      assert.equal(GetAccount(), before);
    });
  }
});
