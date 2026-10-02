import { DefinedFields } from "../../mollie/fields";

type TargetMode = "live" | "stand-in";

export interface TestTarget {
  mode: TargetMode;
  apiKey: string;
  secondApiKey?: string;
  standIn: boolean;
  webhookUrl?: string;
}

export const LIVE_KEY_VARIABLE = "MOLLIE_API_KEY";
export const SECOND_LIVE_KEY_VARIABLE = "MOLLIE_SECOND_API_KEY";
export const STAND_IN_API_KEY = "test_standinprimaryaccount000000000";
const STAND_IN_SECOND_API_KEY = "test_standinsecondaccount0000000000";
const STAND_IN_WEBHOOK_URL = "https://merchant.invalid/mollie/webhook";

const TEST_KEY_PREFIX = "test_";

function assertTestKey(name: string, key: string): void {
  if (!key.startsWith(TEST_KEY_PREFIX)) {
    throw new Error(
      `${name} is not a Mollie test-mode key (test_…); refusing to run the suite against live payments`,
    );
  }
}

export function SelectTarget(
  environment: Record<string, string | undefined>,
): TestTarget {
  const apiKey = environment[LIVE_KEY_VARIABLE];
  if (!apiKey) {
    return {
      mode: "stand-in",
      apiKey: STAND_IN_API_KEY,
      secondApiKey: STAND_IN_SECOND_API_KEY,
      standIn: true,
      webhookUrl: STAND_IN_WEBHOOK_URL,
    };
  }
  assertTestKey(LIVE_KEY_VARIABLE, apiKey);
  const secondApiKey = environment[SECOND_LIVE_KEY_VARIABLE];
  if (secondApiKey) assertTestKey(SECOND_LIVE_KEY_VARIABLE, secondApiKey);
  return {
    mode: "live",
    apiKey,
    standIn: false,
    ...DefinedFields({ secondApiKey }),
  };
}
