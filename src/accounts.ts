import { PaymentError } from "@antelopejs/interface-payment";

import { MollieClient } from "./mollie/client";
import { DefinedFields } from "./mollie/fields";

export interface AccountConfig {
  /** A Mollie API key, `test_…` or `live_…`. */
  apiKey: string;
  /**
   * The public URL of your route that passes deliveries to `VerifyWebhook`.
   * Sent as `webhookUrl` with every payment and subscription this module
   * creates. Without it Mollie calls nothing, and no event is ever raised.
   */
  webhookUrl?: string;
}

export interface Account {
  client: MollieClient;
  webhookUrl?: string;
  /** How long `CapturePayment` follows a capture until Mollie applies it. */
  settleTimeoutMs: number;
}

/** What every account shares, from the module's top-level configuration. */
export interface SharedSettings {
  apiUrl?: string;
  settleTimeoutMs?: number;
}

const accounts = new Map<string, Account>();
const DEFAULT_ACCOUNT = "";
const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

export function RegisterAccount(
  name: string | undefined,
  config: AccountConfig,
  shared: SharedSettings,
): void {
  accounts.set(name ?? DEFAULT_ACCOUNT, {
    client: new MollieClient({ apiKey: config.apiKey, apiUrl: shared.apiUrl }),
    settleTimeoutMs: shared.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
    ...DefinedFields({ webhookUrl: config.webhookUrl || undefined }),
  });
}

export function ClearAccounts(): void {
  accounts.clear();
}

export function GetAccount(provider?: string): Account {
  const account = accounts.get(provider ?? DEFAULT_ACCOUNT);
  if (!account) {
    throw new PaymentError(
      provider
        ? `No Mollie account configured under "${provider}"`
        : "The Mollie module has no default account configured",
    );
  }
  return account;
}
