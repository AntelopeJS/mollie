import { VerifyWebhook } from "@antelopejs/interface-payment";

import { CurrentHarness } from "./harness";

before(() => {
  CurrentHarness().standIn?.receiveWebhooks(async (_url, body) => {
    await VerifyWebhook({
      body: Buffer.from(body),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  });
});

after(() => {
  CurrentHarness().standIn?.receiveWebhooks(undefined);
});
