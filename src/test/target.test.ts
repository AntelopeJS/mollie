import assert from "node:assert/strict";

import { MollieClient } from "../mollie/client";
import { MollieApiError } from "../mollie/errors";
import { Rejected } from "./support/helpers";
import { CurrentHarness, ModuleConfigFor } from "./support/harness";
import {
  LIVE_KEY_VARIABLE,
  SECOND_LIVE_KEY_VARIABLE,
  STAND_IN_API_KEY,
  SelectTarget,
} from "./support/target";

const PROBE_TIMEOUT = 20_000;
const BOGUS_TEST_KEY = "test_antelopejsmolliesuiteprobe0000";

describe("[mollie] switching between the stand-in and live Mollie", function () {
  this.timeout(PROBE_TIMEOUT);

  it("uses the stand-in when no key is set", () => {
    const target = SelectTarget({});
    assert.equal(target.mode, "stand-in");
    assert.equal(target.apiKey, STAND_IN_API_KEY);
  });

  it("goes live with a test key, and nothing in the module config points elsewhere", () => {
    const target = SelectTarget({ [LIVE_KEY_VARIABLE]: "test_abc" });
    assert.equal(target.mode, "live");
    assert.equal(target.standIn, false);
    const config = ModuleConfigFor({
      ...CurrentHarness(),
      target,
      apiUrl: undefined,
    });
    assert.equal(
      config.apiUrl,
      undefined,
      "the module falls back to api.mollie.com",
    );
    assert.equal(config.webhookUrl, undefined);
    assert.equal(config.apiKey, "test_abc");
  });

  it("keeps Mollie's key shape in the stand-in, which answers a malformed key as Mollie does", async function () {
    const standIn = CurrentHarness().standIn;
    if (!standIn) this.skip();
    const malformed = new MollieClient({
      apiKey: "test_tooshort",
      apiUrl: standIn.url,
    });
    const unknown = new MollieClient({
      apiKey: `test_${"x".repeat(30)}`,
      apiUrl: standIn.url,
    });
    const statusOf = async (client: MollieClient) =>
      (
        await Rejected(
          client.request({ method: "GET", path: "/payments/tr_abcdefghij" }),
          MollieApiError,
        )
      ).status;
    assert.equal(await statusOf(malformed), 400);
    assert.equal(await statusOf(unknown), 401);
  });

  it("refuses a live key, for either account", () => {
    assert.throws(() => SelectTarget({ [LIVE_KEY_VARIABLE]: "live_abc" }));
    assert.throws(() =>
      SelectTarget({
        [LIVE_KEY_VARIABLE]: "test_abc",
        [SECOND_LIVE_KEY_VARIABLE]: "live_def",
      }),
    );
  });

  it("reaches the real Mollie API and reads a refused key as an error, not a missing record", async function () {
    const client = new MollieClient({ apiKey: BOGUS_TEST_KEY });
    const error = await Rejected(
      client.request({ method: "GET", path: "/payments/tr_antelopeprobe" }),
      MollieApiError,
    );
    if (error.status === 0) this.skip();
    assert.equal(error.status, 401);
    assert.equal(error.isNotFound, false);
  });
});
