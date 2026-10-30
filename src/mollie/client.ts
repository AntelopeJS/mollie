import { MollieApiError, type MollieErrorBody } from "./errors";
import { DefinedFields } from "./fields";
import { ParseJson } from "./json";
import type { JsonValue } from "./types";

const LIVE_API_URL = "https://api.mollie.com";

const API_VERSION_PATH = "/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const NO_CONTENT = 204;
const USER_AGENT = "antelopejs-mollie";
const IDEMPOTENT_METHODS = new Set(["POST"]);

type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST";

export interface MollieRequest {
  method: HttpMethod;
  path: string;
  body?: object;
  idempotencyKey?: string;
  query?: Record<string, string>;
}

export interface MollieClientOptions {
  apiKey: string;
  apiUrl?: string;
}

interface HalLink {
  href: string;
}

interface ListLinks {
  next?: HalLink | null;
}

interface ListPage<T> {
  _embedded?: Record<string, T[]>;
  _links?: ListLinks;
}

export class MollieClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;

  constructor(options: MollieClientOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? LIVE_API_URL).replace(/\/+$/, "");
  }

  async request<T>(request: MollieRequest): Promise<T> {
    const response = await this.send(request);
    if (response.status === NO_CONTENT) {
      return undefined as T;
    }
    const text = await response.text();
    const body = parseBody(text);
    if (!response.ok) {
      throw new MollieApiError(response.status, body as MollieErrorBody);
    }
    return body as T;
  }

  async list<T>(path: string, resource: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = `${API_VERSION_PATH}${path}`;
    while (next) {
      const page: ListPage<T> = await this.request<ListPage<T>>({
        method: "GET",
        path: next,
      });
      items.push(...(page._embedded?.[resource] ?? []));
      next = relativeLink(page._links?.next?.href);
    }
    return items;
  }

  private async send(request: MollieRequest): Promise<Response> {
    try {
      return await fetch(this.url(request), {
        method: request.method,
        headers: this.headers(request),
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw MollieApiError.unreachable(error);
    }
  }

  private url(request: MollieRequest): string {
    const path = request.path.startsWith(API_VERSION_PATH)
      ? request.path
      : `${API_VERSION_PATH}${request.path}`;
    const query = new URLSearchParams(request.query ?? {}).toString();
    return `${this.apiUrl}${path}${query ? `?${query}` : ""}`;
  }

  private headers(request: MollieRequest) {
    return {
      Accept: "application/hal+json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": USER_AGENT,
      ...DefinedFields({
        "Content-Type": request.body ? "application/json" : undefined,
        "Idempotency-Key":
          request.idempotencyKey && IDEMPOTENT_METHODS.has(request.method)
            ? request.idempotencyKey
            : undefined,
      }),
    };
  }
}

function parseBody(text: string): JsonValue {
  if (!text) {
    return {};
  }
  try {
    return ParseJson(text);
  } catch {
    return { detail: text };
  }
}

function relativeLink(href: string | undefined): string | undefined {
  if (!href) {
    return undefined;
  }
  const url = new URL(href);
  return `${url.pathname}${url.search}`;
}
