import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";

import * as pages from "./pages";
import * as payments from "./payments-api";
import { StandInError } from "./responses";
import * as customers from "./customers-api";
import { DefinedFields, Lookup } from "../../mollie/fields";
import * as subscriptions from "./subscriptions-api";
import { ParseJson } from "../../mollie/json";
import { IsJsonObject } from "../../mollie/metadata";
import type { MollieCapture, MolliePayment } from "../../mollie/types";
import { type PaymentHooks, Transition } from "./payments";
import {
  type Account,
  type Delivery,
  NewAccount,
  type StandInBody,
  type StandInResponse,
} from "./state";

type ApiHandler = (request: payments.Request) => StandInResponse;
type PageHandler = (request: pages.PageRequest) => StandInResponse;

interface ApiRoute {
  method: string;
  pattern: RegExp;
  handle: ApiHandler;
}

export type WebhookReceiver = (url: string, body: string) => Promise<void>;

const ID = "([A-Za-z0-9_]+)";
const IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000;
const CAPTURE_DELAY_MS = 100;
const BEARER = /^Bearer ((?:test|live)_[A-Za-z0-9]{30})$/;
const JSON_TYPE = { "Content-Type": "application/hal+json" };

const API_ROUTES: ApiRoute[] = (
  [
    ["POST", "/v2/payments", payments.CreatePayment],
    ["GET", "/v2/payments", payments.ListPayments],
    ["GET", `/v2/payments/${ID}`, payments.GetPayment],
    ["DELETE", `/v2/payments/${ID}`, payments.CancelPayment],
    ["POST", `/v2/payments/${ID}/captures`, payments.CreateCapture],
    ["GET", `/v2/payments/${ID}/captures`, payments.ListCaptures],
    ["GET", `/v2/payments/${ID}/refunds`, payments.ListRefunds],
    [
      "POST",
      `/v2/payments/${ID}/release-authorization`,
      payments.ReleaseAuthorization,
    ],
    ["POST", `/v2/payments/${ID}/refunds`, payments.CreateRefund],
    ["GET", `/v2/payments/${ID}/refunds/${ID}`, payments.GetRefund],
    ["POST", "/v2/customers", customers.CreateCustomer],
    ["GET", `/v2/customers/${ID}`, customers.GetCustomer],
    ["PATCH", `/v2/customers/${ID}`, customers.UpdateCustomer],
    ["DELETE", `/v2/customers/${ID}`, customers.DeleteCustomer],
    ["GET", `/v2/customers/${ID}/payments`, customers.ListCustomerPayments],
    ["GET", `/v2/customers/${ID}/mandates`, customers.ListMandates],
    ["POST", `/v2/customers/${ID}/mandates`, customers.CreateMandate],
    ["GET", `/v2/customers/${ID}/mandates/${ID}`, customers.GetMandate],
    ["DELETE", `/v2/customers/${ID}/mandates/${ID}`, customers.RevokeMandate],
    [
      "POST",
      `/v2/customers/${ID}/subscriptions`,
      subscriptions.CreateSubscription,
    ],
    [
      "GET",
      `/v2/customers/${ID}/subscriptions`,
      subscriptions.ListSubscriptions,
    ],
    [
      "GET",
      `/v2/customers/${ID}/subscriptions/${ID}`,
      subscriptions.GetSubscription,
    ],
    [
      "PATCH",
      `/v2/customers/${ID}/subscriptions/${ID}`,
      subscriptions.UpdateSubscription,
    ],
    [
      "DELETE",
      `/v2/customers/${ID}/subscriptions/${ID}`,
      subscriptions.CancelSubscription,
    ],
    [
      "GET",
      `/v2/customers/${ID}/subscriptions/${ID}/payments`,
      subscriptions.ListSubscriptionPayments,
    ],
  ] satisfies [string, string, ApiHandler][]
).map(([method, path, handle]) => ({
  method,
  pattern: new RegExp(`^${path}$`),
  handle,
}));

const PAGE_ROUTES = {
  "GET /checkout/select-method": pages.SelectMethodPage,
  "POST /checkout/select-method": pages.ChooseMethod,
  "GET /checkout/test-mode": pages.TestModePage,
  "POST /checkout/test-mode": pages.SubmitTestMode,
} satisfies Record<string, PageHandler>;

function isTextBody(body: StandInBody | undefined): body is string {
  return typeof body === "string";
}

export function IsTcpAddress(
  address: string | AddressInfo | null,
): address is AddressInfo {
  return typeof address === "object" && address !== null;
}

function isSingleHeader(value: string | string[] | undefined): value is string {
  return typeof value === "string";
}

function parseRequestBody(raw: string): payments.Request["body"] {
  if (!raw) return {};
  const parsed = ParseJson(raw);
  return IsJsonObject(parsed) ? parsed : {};
}

const METADATA_BYTES = 1024;

function assertMetadataFits(body: payments.Request["body"]): void {
  if (
    body.metadata !== undefined &&
    Buffer.byteLength(JSON.stringify(body.metadata), "utf8") > METADATA_BYTES
  ) {
    throw new StandInError(
      422,
      "The metadata storage is currently limited to 1024 bytes",
      "metadata",
    );
  }
}

function send(response: ServerResponse, result: StandInResponse): void {
  const isText = isTextBody(result.body);
  const isJson = !isText && result.body !== undefined;
  response.writeHead(result.status, {
    ...(isJson && JSON_TYPE),
    ...result.headers,
  });
  response.end(
    result.body === undefined
      ? undefined
      : isText
        ? result.body
        : JSON.stringify(result.body),
  );
}

export class MollieStandIn {
  readonly accounts = new Map<string, Account>();
  readonly deliveries: Delivery[] = [];
  outage: number | undefined;
  /** Requests that answer a status once each, matched by method and path, before any route runs. */
  readonly faults: { method: string; path: RegExp; status: number }[] = [];
  /** Work that runs once each just before a matching request is handled, as another caller acting in between. */
  readonly interceptions: {
    method: string;
    path: RegExp;
    run: (account: Account) => void;
  }[] = [];
  /** Requests answered late once each, matched by method and path, as a slow Mollie. */
  readonly delays: { method: string; path: RegExp; ms: number }[] = [];
  /** How long a capture stays `pending` before it settles; `undefined` holds every capture until `settleCaptures`. */
  captureDelayMs: number | undefined = CAPTURE_DELAY_MS;
  /** How a capture settles: `failed` as Mollie rejects a capture of an expired authorization. */
  captureOutcome: payments.CaptureOutcome = "succeeded";
  /** Requests held for `ms` before any route runs, every time, matched by method and path. */
  readonly latencies: { method: string; path: RegExp; ms: number }[] = [];
  private receiver: WebhookReceiver | undefined;
  private server: Server | undefined;
  private baseUrl = "";
  private readonly hooks: PaymentHooks = {
    baseUrl: "",
    notify: (account, payment) => this.notify(account, payment),
    captured: (account, capture) => this.schedule(account, capture),
  };

  constructor(apiKeys: string[]) {
    for (const key of apiKeys) this.accounts.set(key, NewAccount());
  }

  get url(): string {
    return this.baseUrl;
  }

  async start(): Promise<string> {
    this.server = createServer((message, response) => {
      void this.handle(message, response);
    });
    await new Promise<void>((resolve) =>
      this.server?.listen(0, "127.0.0.1", resolve),
    );
    const address = this.server.address();
    if (!IsTcpAddress(address))
      throw new Error("The stand-in is not listening on a TCP port");
    const { port } = address;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.hooks.baseUrl = this.baseUrl;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  receiveWebhooks(receiver: WebhookReceiver | undefined): void {
    this.receiver = receiver;
  }

  account(apiKey: string): Account {
    const account = this.accounts.get(apiKey);
    if (!account) throw new Error(`The stand-in has no account for ${apiKey}`);
    return account;
  }

  get paymentHooks(): PaymentHooks {
    return this.hooks;
  }

  settle(
    apiKey: string,
    payment: MolliePayment,
    status: MolliePayment["status"],
  ): void {
    Transition(this.account(apiKey), this.hooks, payment, status);
  }

  /** Settles every pending capture of the account, as Mollie does once it has processed them. */
  settleCaptures(apiKey: string): void {
    const account = this.account(apiKey);
    for (const capture of account.captures.values()) {
      payments.SettleCapture(account, this.hooks, capture, this.captureOutcome);
    }
  }

  private schedule(account: Account, capture: MollieCapture): void {
    if (this.captureDelayMs === undefined) return;
    const outcome = this.captureOutcome;
    setTimeout(
      () => payments.SettleCapture(account, this.hooks, capture, outcome),
      this.captureDelayMs,
    ).unref();
  }

  private async lag(message: IncomingMessage, url: URL): Promise<void> {
    const index = this.delays.findIndex(
      (entry) =>
        entry.method === message.method && entry.path.test(url.pathname),
    );
    if (index === -1) return;
    const [{ ms }] = this.delays.splice(index, 1);
    await new Promise((resolve) => setTimeout(resolve, ms).unref());
  }

  private notify(_account: Account, payment: MolliePayment): void {
    const url = payment.webhookUrl;
    if (!url) return;
    const body = `id=${payment.id}`;
    setImmediate(() => void this.deliver(url, body));
  }

  private async deliver(url: string, body: string): Promise<void> {
    if (!this.receiver) return;
    try {
      await this.receiver(url, body);
      this.deliveries.push({ url, body, outcome: "delivered" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deliveries.push({ url, body, outcome: "failed", error: reason });
    }
  }

  private async handle(
    message: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(message.url ?? "/", this.baseUrl);
    const raw = await text(message);
    await this.lag(message, url);
    const latency = this.latencies.find(
      (entry) =>
        entry.method === message.method && entry.path.test(url.pathname),
    );
    if (latency) await delay(latency.ms, undefined, { ref: false });
    try {
      const result = url.pathname.startsWith("/v2/")
        ? this.api(message, url, raw)
        : this.page(message, url, raw);
      send(response, result);
    } catch (error) {
      if (!(error instanceof StandInError)) throw error;
      send(response, error.toResponse());
    }
  }

  private page(
    message: IncomingMessage,
    url: URL,
    raw: string,
  ): StandInResponse {
    const [, , section, pathToken] = url.pathname.split("/");
    const handler = Lookup(
      PAGE_ROUTES,
      `${message.method} /checkout/${section}`,
    );
    if (!handler)
      return {
        status: 404,
        body: "Not found",
        headers: { "Content-Type": "text/plain" },
      };
    const form = new URLSearchParams(raw);
    const token =
      pathToken ?? url.searchParams.get("token") ?? form.get("token") ?? "";
    const account = [...this.accounts.values()].find((candidate) =>
      candidate.tokens.has(token),
    );
    if (!account)
      return {
        status: 404,
        body: "Unknown checkout",
        headers: { "Content-Type": "text/plain" },
      };
    return handler({ account, hooks: this.hooks, token, form });
  }

  private authenticate(message: IncomingMessage): Account {
    const header = message.headers.authorization;
    const key = BEARER.exec(header ?? "")?.[1];
    if (!header || !key)
      throw new StandInError(400, "Invalid Authorization header");
    const account = this.accounts.get(key);
    if (!account)
      throw new StandInError(
        401,
        "Missing authentication, or failed to authenticate",
      );
    return account;
  }

  private api(
    message: IncomingMessage,
    url: URL,
    raw: string,
  ): StandInResponse {
    const account = this.authenticate(message);
    if (this.outage)
      throw new StandInError(
        this.outage,
        "The service is temporarily unavailable",
      );
    const fault = this.faults.findIndex(
      (entry) =>
        entry.method === message.method && entry.path.test(url.pathname),
    );
    if (fault !== -1) {
      const [{ status }] = this.faults.splice(fault, 1);
      throw new StandInError(status, "The service is temporarily unavailable");
    }
    const interception = this.interceptions.findIndex(
      (entry) =>
        entry.method === message.method && entry.path.test(url.pathname),
    );
    if (interception !== -1) {
      const [{ run }] = this.interceptions.splice(interception, 1);
      run(account);
    }
    const route = API_ROUTES.map((candidate) => ({
      candidate,
      match:
        candidate.method === message.method
          ? candidate.pattern.exec(url.pathname)
          : null,
    })).find((entry) => entry.match);
    if (!route?.match)
      throw new StandInError(
        404,
        `No route for ${message.method} ${url.pathname}`,
      );
    const body = parseRequestBody(raw);
    const run = () => {
      assertMetadataFits(body);
      return route.candidate.handle({
        account,
        hooks: this.hooks,
        params: route.match?.slice(1) ?? [],
        query: url.searchParams,
        body,
      });
    };
    const key = message.headers["idempotency-key"];
    account.requests.push({
      method: message.method ?? "",
      path: url.pathname,
      body,
      ...DefinedFields({
        idempotencyKey: isSingleHeader(key) ? key : undefined,
      }),
    });
    if (message.method !== "POST" || !isSingleHeader(key)) return run();
    return this.idempotent(
      account,
      key,
      `${message.method} ${url.pathname}`,
      raw,
      run,
    );
  }

  private idempotent(
    account: Account,
    key: string,
    endpoint: string,
    raw: string,
    run: () => StandInResponse,
  ): StandInResponse {
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    const previous = account.replays.get(key);
    const isFresh =
      previous && Date.now() - previous.storedAt < IDEMPOTENCY_WINDOW_MS;
    if (previous && isFresh) {
      if (
        previous.endpoint !== endpoint ||
        previous.fingerprint !== fingerprint
      ) {
        throw new StandInError(
          400,
          "The idempotency key was already used for a different request",
        );
      }
      return {
        ...previous.response,
        headers: {
          ...previous.response.headers,
          "Idempotent-Replayed": "true",
        },
      };
    }
    const response = this.capture(run);
    account.replays.set(key, {
      fingerprint,
      endpoint,
      storedAt: Date.now(),
      response,
    });
    return response;
  }

  private capture(run: () => StandInResponse): StandInResponse {
    try {
      const response = run();
      return { ...response, body: structuredClone(response.body) };
    } catch (error) {
      if (!(error instanceof StandInError)) throw error;
      return error.toResponse();
    }
  }
}
