import { randomBytes } from "node:crypto";

import { IsJsonNumber, IsJsonString } from "../../mollie/metadata";

import type {
  JsonObject,
  JsonValue,
  MollieCapture,
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

interface HalLink {
  href: string;
  type: string;
}

interface ListedResource {
  id: string;
  createdAt: string;
}

/** A page of a list endpoint, as Mollie answers it. */
export interface ListBody {
  count: number;
  _embedded: Record<string, ListedResource[]>;
  _links: { next: HalLink | null };
}

/** An error answer, in Mollie's error format. */
export interface ErrorBody {
  status: number;
  title: string;
  detail: string;
  field?: string;
  _links: { documentation: HalLink };
}

/** What the stand-in answers: a page as text, or a resource sent as JSON. */
export type StandInBody =
  | string
  | JsonValue
  | MolliePayment
  | MollieRefund
  | MollieCustomer
  | MollieMandate
  | MollieSubscription
  | MollieCapture
  | ListBody
  | ErrorBody;

export interface StandInResponse {
  status: number;
  body?: StandInBody;
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
  body: JsonObject;
  idempotencyKey?: string;
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
  captures: Map<string, MollieCapture>;
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

function isText(value: JsonValue | undefined): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/** The value when it is a JSON string, otherwise `undefined`. */
export function TextOf(value: JsonValue | undefined): string | undefined {
  return IsJsonString(value) ? value : undefined;
}

/** The value when it is a JSON number, otherwise `undefined`. */
export function CountOf(value: JsonValue | undefined): number | undefined {
  return IsJsonNumber(value) ? value : undefined;
}

export function Text(value: JsonValue | undefined): string {
  return isText(value) ? String(value) : "";
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
