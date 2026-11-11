import { PaymentError } from "@antelopejs/interface-payment";
import {
  SubscriptionError,
  SubscriptionNotFoundError,
} from "@antelopejs/interface-subscriptions";

import { MollieApiError } from "../../mollie/errors";
import { type Account, GetAccount } from "../../accounts";

/**
 * A subscription of this module whose period neither its metadata nor Mollie
 * gives: its stored interval was changed, and Mollie reports an interval in a
 * form Mollie does not document.
 */
export class UnreadablePeriodError extends SubscriptionError {
  constructor(id: string, mollieInterval: string) {
    super(
      `Subscription ${id} has no period this module can read: its stored interval was changed, and Mollie reports the interval "${mollieInterval}"`,
    );
  }
}

function TranslateSubscriptionError(error: MollieApiError, id: string): Error {
  if (error.isNotFound) {
    return new SubscriptionNotFoundError(id, error.providerCode);
  }
  return new SubscriptionError(error.message, error.providerCode);
}

export async function TranslatingSubscription<T>(
  id: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof MollieApiError)) throw error;
    throw TranslateSubscriptionError(error, id);
  }
}

export function SubscriptionAccount(provider?: string): Account {
  try {
    return GetAccount(provider);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    throw new SubscriptionError(error.message);
  }
}
