import * as payment from "@antelopejs/interface-payment";
import { ImplementInterface } from "@antelopejs/interface-core";
import * as subscriptions from "@antelopejs/interface-subscriptions";

import { type AccountConfig, ClearAccounts, RegisterAccount } from "./accounts";

export type { AccountConfig } from "./accounts";

/**
 * Configuration of the Mollie module.
 *
 * The top-level account is the default, used when a call names no provider.
 */
export interface Config extends AccountConfig {
  /**
   * Further Mollie accounts, keyed by the name callers pass as the interfaces'
   * trailing `provider` selector.
   */
  accounts?: Record<string, AccountConfig>;
  /**
   * Where the Mollie API lives. Defaults to `https://api.mollie.com`; the test
   * suite points it at a local stand-in.
   */
  apiUrl?: string;
  /**
   * How long `CapturePayment` waits for Mollie to apply a capture, in every
   * account. Mollie accepts a capture as `pending` and applies it about a
   * second later; past this budget the payment is returned `pending`, with the
   * amount being captured. `0` returns as soon as Mollie accepts the capture.
   * A finite number, 0 or more; any other value makes `construct` reject.
   * Default 10 seconds.
   */
  settleTimeoutMs?: number;
}

export async function construct(config: Config): Promise<void> {
  const shared = {
    apiUrl: config.apiUrl,
    settleTimeoutMs: config.settleTimeoutMs,
  };
  RegisterAccount(undefined, config, shared);
  for (const [name, account] of Object.entries(config.accounts ?? {})) {
    RegisterAccount(name, account, shared);
  }
  ImplementInterface(payment, await import("./implementations/payment"));
  ImplementInterface(
    subscriptions,
    await import("./implementations/subscriptions"),
  );
}

export function destroy(): void {
  ClearAccounts();
}
