import { PaymentError } from "@antelopejs/interface-payment";
import {
  SubscriptionError,
  SubscriptionNotFoundError,
} from "@antelopejs/interface-subscriptions";

import { MollieApiError } from "../../mollie/errors";
import { type Account, GetAccount } from "../../accounts";

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
