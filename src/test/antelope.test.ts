import { defineConfig } from "@antelopejs/interface-core/config";

import {
  ModuleConfigFor,
  StartHarness,
  StopHarness,
  SuiteEnvironment,
} from "./support/harness";

export default defineConfig({
  name: "mollie-test",
  cacheFolder: ".antelope/cache",
  modules: {
    local: { source: { type: "local", path: "." } },
  },
  test: {
    folder: "dist/test",
    async setup() {
      const harness = await StartHarness(process.env);
      Object.assign(process.env, SuiteEnvironment(harness));
      return { modules: { local: { config: ModuleConfigFor(harness) } } };
    },
    async cleanup() {
      await StopHarness();
    },
  },
});
