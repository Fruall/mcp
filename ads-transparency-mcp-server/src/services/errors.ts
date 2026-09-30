export type GatcErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "ACCESS_DENIED"
  | "UPSTREAM_CHANGED"
  | "UPSTREAM_ERROR"
  | "NETWORK";

export class GatcError extends Error {
  constructor(
    public readonly code: GatcErrorCode,
    message: string,
    /** Whether a later attempt can succeed (plain 429, 5xx, network), as opposed to a CAPTCHA wall. */
    public readonly retriable = false,
  ) {
    super(message);
    this.name = "GatcError";
  }
}

/** Turns any error into a message that tells the model what to do next. */
export function describeError(error: unknown): string {
  if (error instanceof GatcError) {
    switch (error.code) {
      case "INVALID_INPUT":
        return `Error: ${error.message}`;
      case "NOT_FOUND":
        return `Error: ${error.message} Check the ID, or find it again with gatc_search_advertisers / gatc_list_creatives.`;
      case "RATE_LIMITED":
        return (
          `Error: Google is throttling requests from this machine (${error.message}). ` +
          "Wait a few minutes before retrying, reduce the number of targets or the limit, " +
          "or raise GATC_MIN_INTERVAL_MS. Cached results remain available."
        );
      case "ACCESS_DENIED":
        return (
          `Error: access to Google was refused (${error.message}). ` +
          "Check the network (proxy/firewall, see HTTPS_PROXY and NODE_USE_ENV_PROXY) or run the server from another connection."
        );
      case "UPSTREAM_CHANGED":
        return (
          `Error: the Ads Transparency Center answered in an unexpected shape (${error.message}). ` +
          "Google may have changed its internal API; the server needs an update."
        );
      case "UPSTREAM_ERROR":
        return `Error: the Ads Transparency Center returned an error (${error.message}). Retry later.`;
      case "NETWORK":
        return `Error: network problem while reaching Google (${error.message}). Check connectivity and retry.`;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Error: unexpected failure: ${message}`;
}
