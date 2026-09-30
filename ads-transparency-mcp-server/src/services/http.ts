import { ATC_ORIGIN, ATC_RPC_BASE, USER_AGENT } from "../constants.js";
import { GatcError } from "./errors.js";
import { Limiter } from "./limiter.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetchImpl?: FetchLike;
  minIntervalMs: number;
  concurrency: number;
  timeoutMs: number;
  /** Retries after a 429/5xx/network failure (not after a CAPTCHA wall). */
  retries?: number;
}

export interface BinaryResponse {
  bytes: Uint8Array;
  contentType: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transport for Google's endpoints. The RPC host goes through a polite limiter;
 * asset hosts (render scripts, images) through a separate, wider one.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly rpcLimiter: Limiter;
  private readonly assetLimiter: Limiter;
  private readonly retries: number;

  constructor(private readonly options: HttpOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.rpcLimiter = new Limiter(options.concurrency, options.minIntervalMs);
    this.assetLimiter = new Limiter(Math.max(4, options.concurrency * 2), 0);
    this.retries = options.retries ?? 2;
  }

  /** POSTs one RPC to the Ads Transparency Center and returns the decoded JSON. */
  async rpc<T = Record<string, unknown>>(service: string, request: unknown): Promise<T> {
    const url = `${ATC_RPC_BASE}/${service}?authuser=`;
    const body = `f.req=${encodeURIComponent(JSON.stringify(request))}`;
    const text = await this.withRetries(service, () =>
      this.rpcLimiter.run(async () => {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "*/*",
            "user-agent": USER_AGENT,
            origin: ATC_ORIGIN,
            referer: `${ATC_ORIGIN}/`,
          },
          body,
          redirect: "follow",
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        return this.readRpcResponse(res, service);
      }),
    );
    // Unknown IDs come back as an empty 200 body.
    if (text.trim() === "") return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GatcError("UPSTREAM_CHANGED", `${service} did not return JSON`);
    }
  }

  async getText(url: string): Promise<string> {
    return this.withRetries(url, () =>
      this.assetLimiter.run(async () => {
        const res = await this.fetchImpl(url, {
          headers: { "user-agent": USER_AGENT, referer: `${ATC_ORIGIN}/` },
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        this.throwForStatus(res, url);
        return res.text();
      }),
    );
  }

  async getBinary(url: string): Promise<BinaryResponse> {
    return this.withRetries(url, () =>
      this.assetLimiter.run(async () => {
        const res = await this.fetchImpl(url, {
          headers: { "user-agent": USER_AGENT, referer: `${ATC_ORIGIN}/` },
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        this.throwForStatus(res, url);
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { bytes, contentType: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream" };
      }),
    );
  }

  private async readRpcResponse(res: Response, service: string): Promise<string> {
    if (res.url && res.url.includes("/sorry/")) {
      throw new GatcError("RATE_LIMITED", "redirected to Google's /sorry/ CAPTCHA page");
    }
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html") || text.trimStart().startsWith("<");
    // A CAPTCHA wall can come with 200 or 429: detect it first, and never retry it.
    if (isHtml && /sorry|captcha|unusual traffic/i.test(text)) {
      throw new GatcError("RATE_LIMITED", "Google answered with a CAPTCHA page");
    }
    if (!res.ok) {
      // Unknown IDs return 200 with an empty body, so a 400/404 on the RPC means the request format changed.
      if (res.status === 400 || res.status === 404) {
        throw new GatcError("UPSTREAM_CHANGED", `HTTP ${res.status} on ${service}`);
      }
      this.throwForStatus(res, service);
    }
    if (isHtml) throw new GatcError("UPSTREAM_CHANGED", `${service} answered with HTML instead of JSON`);
    return text;
  }

  private throwForStatus(res: Response, what: string): void {
    if (res.ok) return;
    const where = shorten(what);
    if (res.status === 429) throw new GatcError("RATE_LIMITED", `HTTP 429 on ${where}`, true);
    if (res.status === 404) throw new GatcError("NOT_FOUND", `HTTP 404 on ${where}.`);
    if (res.status === 401 || res.status === 403) {
      throw new GatcError("ACCESS_DENIED", `HTTP ${res.status} on ${where}, from a proxy/firewall or from Google blocking this IP`);
    }
    if (res.status >= 500) throw new GatcError("UPSTREAM_ERROR", `HTTP ${res.status} on ${where}`, true);
    throw new GatcError("UPSTREAM_CHANGED", `HTTP ${res.status} on ${where}`);
  }

  private async withRetries<T>(what: string, attempt: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i <= this.retries; i++) {
      try {
        return await attempt();
      } catch (error) {
        lastError = normalizeFetchError(error, what);
        const retriable = lastError instanceof GatcError && lastError.retriable;
        if (!retriable || i === this.retries) break;
        await sleep(1_000 * 2 ** i + Math.random() * 500);
      }
    }
    throw lastError;
  }
}

function normalizeFetchError(error: unknown, what: string): unknown {
  if (error instanceof GatcError) return error;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return new GatcError("NETWORK", `timeout on ${shorten(what)}`, true);
    }
    return new GatcError("NETWORK", `${error.message} on ${shorten(what)}`, true);
  }
  return error;
}

function shorten(what: string): string {
  return what.length > 80 ? `${what.slice(0, 77)}...` : what;
}

/** Base64 without depending on Node's Buffer (so the core also runs in a browser). */
export function toBase64(bytes: Uint8Array): string {
  const maybeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (maybeBuffer) return maybeBuffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
