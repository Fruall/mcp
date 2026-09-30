// Live check of the core against the real Transparency Center, run inside a browser tab on
// adstransparency.google.com (the build machine has no route to Google). Same code as the server.
import { AtcService } from "../../src/services/atc.js";
import { TtlCache } from "../../src/services/cache.js";
import { HttpClient } from "../../src/services/http.js";
import { resolveRegion } from "../../src/services/regions.js";

// Browsers refuse to set user-agent/origin/referer; keep only the content type.
const browserFetch = (url: string, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  const ct = (init?.headers as Record<string, string> | undefined)?.["content-type"];
  if (ct) headers["content-type"] = ct;
  return fetch(url, { ...init, headers });
};

export function makeService(lang: "fr" | "en" = "fr") {
  return new AtcService(
    new HttpClient({ fetchImpl: browserFetch, minIntervalMs: 300, concurrency: 2, timeoutMs: 20_000 }),
    new TtlCache(),
    lang,
  );
}

export { resolveRegion, AtcService };
