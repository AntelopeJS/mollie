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
}

export async function construct(config: Config): Promise<void> {
  RegisterAccount(undefined, config, config.apiUrl);
  for (const [name, account] of Object.entries(config.accounts ?? {})) {
    RegisterAccount(name, account, config.apiUrl);
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
