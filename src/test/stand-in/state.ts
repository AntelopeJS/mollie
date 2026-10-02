import { randomBytes } from "node:crypto";

import type {
  MollieAmount,
  MollieCustomer,
  MollieMandate,
  MolliePayment,
  MollieRefund,
  MollieSubscription,
} from "../../mollie/types";

interface Replay {
  fingerprint: string;
  endpoint: string;
  storedAt: number;
  response: StandInResponse;
}

export interface StandInResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Delivery {
  url: string;
  body: string;
  outcome: "delivered" | "failed";
  error?: string;
}

interface LoggedRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface Capture {
  resource: "capture";
  id: string;
  mode: "test";
  amount: MollieAmount;
  status: "succeeded";
  paymentId: string;
  metadata: unknown;
  createdAt: string;
}

export interface Account {
  payments: Map<string, MolliePayment>;
  refunds: Map<string, MollieRefund>;
  customers: Map<string, MollieCustomer>;
  deletedCustomers: Set<string>;
  mandates: Map<string, MollieMandate>;
  subscriptions: Map<string, MollieSubscription>;
  replays: Map<string, Replay>;
  tokens: Map<string, string>;
  declinesAtCreation: Set<string>;
  requests: LoggedRequest[];
  captures: Map<string, Capture>;
}

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 10;

export function NewAccount(): Account {
  return {
    payments: new Map(),
    refunds: new Map(),
    customers: new Map(),
    deletedCustomers: new Set(),
    mandates: new Map(),
    subscriptions: new Map(),
    replays: new Map(),
    tokens: new Map(),
    declinesAtCreation: new Set(),
    requests: [],
    captures: new Map(),
  };
}

export function NewId(prefix: string): string {
  const bytes = randomBytes(ID_LENGTH);
  const body = [...bytes]
    .map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length])
    .join("");
  return `${prefix}_${body}`;
}

export function Text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

export function NowIso(): string {
  return new Date(Date.now()).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function IsoIn(milliseconds: number): string {
  return new Date(Date.now() + milliseconds)
    .toISOString()
    .replace(/\.\d{3}Z$/, "+00:00");
}

interface Created {
  createdAt: string;
}

export function NewestFirst<T extends Created>(items: Iterable<T>): T[] {
  return [...items]
    .reverse()
    .sort(
      (first, second) =>
        Date.parse(second.createdAt) - Date.parse(first.createdAt),
    );
}
