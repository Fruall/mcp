import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { Config } from "./config.js";
import { AtcService } from "./services/atc.js";
import { TtlCache } from "./services/cache.js";
import { HttpClient, type FetchLike } from "./services/http.js";
import { registerAdvertiserTools } from "./tools/advertisers.js";
import { registerCompareTools } from "./tools/compare.js";
import { registerCreativeTools } from "./tools/creatives.js";
import { registerExportTools } from "./tools/export.js";

const INSTRUCTIONS = `Google Ads Transparency Center: public data on the ads advertisers run on Google Search, YouTube, Display, Shopping, Maps and Play.

Typical flow:
1. gatc_search_advertisers to turn a brand into advertiser IDs (AR…); brands often have several accounts, agencies included.
2. gatc_get_advertiser or gatc_compare_advertisers for volumes by format and platform (Google's rounded estimates).
3. gatc_list_creatives to list ads (filters: country, format, platform, dates, new_since).
4. gatc_view_creatives / gatc_get_creative to see the ads themselves (images are returned inline so you can read the copy), impressions per country and audience criteria.
5. gatc_export_creatives for complete inventories as CSV/JSON.

Data notes: counts and impressions are Google's rounded ranges, reported as they are; impressions exist only for EEA/Turkey countries and lag about 90 days; most search ads are exposed as images, not text; this relies on the Transparency Center's internal endpoints, which Google can change without notice.`;

export interface ServerDeps {
  atc: AtcService;
  config: Config;
}

export function createDeps(config: Config, fetchImpl?: FetchLike): ServerDeps {
  const http = new HttpClient({
    minIntervalMs: config.minIntervalMs,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { atc: new AtcService(http, new TtlCache(), config.lang), config };
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const ctx = { atc: deps.atc, config: deps.config };
  registerAdvertiserTools(server, ctx);
  registerCompareTools(server, ctx);
  registerCreativeTools(server, ctx);
  registerExportTools(server, ctx);
  return server;
}
