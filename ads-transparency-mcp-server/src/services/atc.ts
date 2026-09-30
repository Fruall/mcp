/**
 * High-level access to the Google Ads Transparency Center.
 * Builds RPC requests, paginates, caches, and enriches creatives from their render scripts.
 */
import { FORMAT_CODES, MAX_PAGE_SIZE, MAX_SCAN, PLATFORM_CODES, type CreativeFormat, type Platform } from "../constants.js";
import type { Lang } from "../i18n.js";
import type { Advertiser, CreativeDetail, CreativePage, CreativeSummary, CreativeVariant, Range, Suggestions } from "../types.js";
import { TtlCache } from "./cache.js";
import { parseRenderScript, youtubeThumbnail, type RenderInfo } from "./content.js";
import { GatcError } from "./errors.js";
import { toBase64, type HttpClient } from "./http.js";
import { dateToYmd, parseAdvertiser, parseCreativeDetail, parseCreativePage, parseSuggestions } from "./parsers.js";
import type { ResolvedRegion } from "./regions.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface CreativeFilters {
  advertiserIds?: string[];
  domain?: string;
  region: ResolvedRegion;
  format?: CreativeFormat;
  platform?: Platform;
  /** Ads shown on or after this date (YYYY-MM-DD). */
  dateFrom?: string;
  /** Ads shown on or before this date (YYYY-MM-DD). */
  dateTo?: string;
}

export interface ListOptions {
  limit: number;
  cursor?: string | null;
  /** Max creatives to page through when a predicate discards some. */
  maxScan?: number;
  predicate?: (creative: CreativeSummary) => boolean;
  /** Absolute ceiling on ads paged through (default MAX_SCAN; exports raise it). */
  hardCap?: number;
  /** Called after each page with the number of ads kept so far. */
  onPage?: (kept: number, scanned: number) => void | Promise<void>;
}

export interface ListResult {
  creatives: CreativeSummary[];
  next_cursor: string | null;
  total_estimate: Range | null;
  scanned: number;
  pages: number;
}

export interface InlineImage {
  url: string;
  mimeType: string;
  base64: string;
  bytes: number;
}

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const ADVERTISER_ID_RE = /^AR\d{15,25}$/;
export const CREATIVE_ID_RE = /^CR\d{15,25}$/;

export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");
  d = d.split(/[/?#]/)[0] ?? d;
  d = d.replace(/:\d+$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(d)) {
    throw new GatcError("INVALID_INPUT", `"${input}" is not a valid domain (expected e.g. "sncf-connect.com").`);
  }
  return d;
}

export class AtcService {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: TtlCache,
    readonly lang: Lang,
  ) {}

  async suggest(query: string): Promise<Suggestions> {
    const q = query.trim();
    return this.cache.getOrLoad(`sugg:${q.toLowerCase()}`, HOUR, async () =>
      parseSuggestions(await this.http.rpc("SearchService/SearchSuggestions", { "1": q, "2": 30, "3": 30 })),
    );
  }

  async getAdvertiser(advertiserId: string): Promise<Advertiser> {
    return this.cache.getOrLoad(`adv:${advertiserId}`, 24 * HOUR, async () =>
      parseAdvertiser(await this.http.rpc("LookupService/GetAdvertiserById", { "1": advertiserId, "3": { "1": 1 } })),
    );
  }

  buildSearchRequest(filters: CreativeFilters, pageSize: number, cursor?: string | null): Record<string, unknown> {
    if (!filters.domain && !filters.advertiserIds?.length) {
      throw new GatcError("INVALID_INPUT", "Provide advertiser_ids or a domain.");
    }
    const query: Record<string, unknown> = {};
    if (filters.format) query["4"] = FORMAT_CODES[filters.format];
    if (filters.dateFrom) query["6"] = dateToYmd(filters.dateFrom);
    // The RPC takes an exclusive end date (the UI sends end + 1 day).
    if (filters.dateTo) query["7"] = dateToYmd(filters.dateTo, 1);
    if (filters.dateFrom && filters.dateTo && dateToYmd(filters.dateFrom) > dateToYmd(filters.dateTo)) {
      throw new GatcError("INVALID_INPUT", "date_from must be on or before date_to.");
    }
    if (filters.region.id !== null) query["8"] = [filters.region.id];
    query["12"] = { "1": filters.domain ?? "", "2": true };
    if (filters.advertiserIds?.length) query["13"] = { "1": filters.advertiserIds };
    if (filters.platform) query["14"] = [PLATFORM_CODES[filters.platform]];
    const request: Record<string, unknown> = { "2": Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE), "3": query };
    if (cursor) request["4"] = cursor;
    request["7"] = filters.region.id !== null ? { "1": 1, "2": 0, "3": filters.region.id } : { "1": 1 };
    return request;
  }

  async searchCreatives(filters: CreativeFilters, pageSize: number, cursor?: string | null): Promise<CreativePage> {
    const request = this.buildSearchRequest(filters, pageSize, cursor);
    const key = `search:${JSON.stringify(request)}`;
    return this.cache.getOrLoad(key, 30 * MINUTE, async () =>
      parseCreativePage(await this.http.rpc("SearchService/SearchCreatives", request), filters.region.code),
    );
  }

  /** Google's rounded estimate of how many creatives match the filters (one lightweight call). */
  async countCreatives(filters: CreativeFilters): Promise<Range | null> {
    const page = await this.searchCreatives(filters, 1);
    if (page.total_estimate) return page.total_estimate;
    return page.creatives.length === 0 ? { lower: 0, upper: 0 } : null;
  }

  async listCreatives(filters: CreativeFilters, options: ListOptions): Promise<ListResult> {
    const limit = Math.max(1, options.limit);
    const maxScan = Math.min(options.maxScan ?? limit, options.hardCap ?? MAX_SCAN);
    const out: CreativeSummary[] = [];
    const seen = new Set<string>();
    let cursor = options.cursor ?? null;
    let scanned = 0;
    let pages = 0;
    let total: Range | null = null;
    do {
      const remainingScan = maxScan - scanned;
      const wanted = options.predicate ? MAX_PAGE_SIZE : limit - out.length;
      const page = await this.searchCreatives(filters, Math.min(MAX_PAGE_SIZE, Math.max(1, Math.min(wanted, remainingScan))), cursor);
      pages++;
      total ??= page.total_estimate;
      scanned += page.creatives.length;
      for (const creative of page.creatives) {
        if (seen.has(creative.creative_id)) continue;
        seen.add(creative.creative_id);
        if (options.predicate && !options.predicate(creative)) continue;
        out.push(creative);
        if (out.length >= limit) break;
      }
      cursor = page.next_cursor;
      if (page.creatives.length === 0) cursor = null;
      await options.onPage?.(out.length, scanned);
    } while (cursor && out.length < limit && scanned < maxScan);
    // An empty first page means no match (Google omits the estimate then).
    if (total === null && !options.cursor && scanned === 0) total = { lower: 0, upper: 0 };
    return { creatives: out.slice(0, limit), next_cursor: cursor, total_estimate: total, scanned, pages };
  }

  async getCreative(advertiserId: string, creativeId: string, region: ResolvedRegion): Promise<CreativeDetail> {
    const request = { "1": advertiserId, "2": creativeId, "5": region.id !== null ? { "1": 1, "2": 0, "3": region.id } : { "1": 1 } };
    return this.cache.getOrLoad(`creative:${advertiserId}:${creativeId}:${region.code}:${this.lang}`, 6 * HOUR, async () => {
      const json = await this.http.rpc("LookupService/GetCreativeById", request);
      if (!json || Object.keys(json).length === 0) {
        throw new GatcError("NOT_FOUND", `Creative ${creativeId} of advertiser ${advertiserId} not found.`);
      }
      return parseCreativeDetail(json, region.code, this.lang);
    });
  }

  async readRenderScript(url: string): Promise<RenderInfo> {
    return this.cache.getOrLoad(`render:${url.replace(/&(htmlParentId|responseCallback)=[^&]*/g, "")}`, 24 * HOUR, async () =>
      parseRenderScript(await this.http.getText(url)),
    );
  }

  /** Adds text / YouTube ID / asset images to variants that only carry a render script. */
  async enrichVariants(variants: CreativeVariant[], max = 6): Promise<CreativeVariant[]> {
    return Promise.all(
      variants.map(async (variant, index) => {
        if (variant.kind !== "render" || !variant.render_url || index >= max) return variant;
        try {
          const info = await this.readRenderScript(variant.render_url);
          return {
            ...variant,
            ...(info.text ? { text: info.text } : {}),
            ...(info.youtube_video_id
              ? { youtube_video_id: info.youtube_video_id, youtube_url: `https://www.youtube.com/watch?v=${info.youtube_video_id}` }
              : {}),
            ...(info.asset_images.length ? { asset_images: info.asset_images } : {}),
          };
        } catch {
          return variant;
        }
      }),
    );
  }

  /** Best image to show for a variant: the static preview, the YouTube thumbnail, or the first asset. */
  static variantImageUrl(variant: CreativeVariant): string | null {
    if (variant.image_url) return variant.image_url;
    if (variant.youtube_video_id) return youtubeThumbnail(variant.youtube_video_id);
    return variant.asset_images?.[0] ?? null;
  }

  async fetchImage(url: string, maxBytes: number): Promise<InlineImage | null> {
    const res = await this.http.getBinary(url);
    // Only formats every MCP client / model accepts.
    if (!INLINE_IMAGE_TYPES.has(res.contentType) || res.bytes.length > maxBytes) return null;
    return { url, mimeType: res.contentType, base64: toBase64(res.bytes), bytes: res.bytes.length };
  }
}
