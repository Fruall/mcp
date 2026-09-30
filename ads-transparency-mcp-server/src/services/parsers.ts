/**
 * Decoders for the Ads Transparency Center RPC payloads (protobuf-JSON with numeric keys).
 * Field meanings were mapped against the live UI on 2026-09-30; see docs/protocol.md.
 */
import {
  ATC_ORIGIN,
  AUDIENCE_CATEGORIES,
  AUDIENCE_KEYS,
  FORMAT_BY_CODE,
  PLATFORM_BY_CODE,
  type AudienceCategory,
} from "../constants.js";
import { PRODUCT_CATEGORY_TOPICS, VERTICAL_TOPICS } from "../data/topics.js";
import type { Lang } from "../i18n.js";
import type {
  Advertiser,
  AudienceUse,
  CreativeDetail,
  CreativePage,
  CreativeSummary,
  CreativeVariant,
  PlatformImpressions,
  Preview,
  Range,
  RegionStats,
  Suggestions,
} from "../types.js";
import { GatcError } from "./errors.js";
import { regionFromId } from "./regions.js";

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

// The Transparency Center reports calendar dates in US Pacific time (like other Google Ads reports):
// a timestamp at 01:00 UTC on the 25th is shown as the 24th in the UI and in per-country stats.
const PACIFIC_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

/** {"1": "<seconds>", "2": <nanos>} -> "YYYY-MM-DD" (US Pacific calendar date, as in the UI). */
export function timestampToDate(value: unknown): string | null {
  const seconds = num(obj(value)?.["1"]);
  if (seconds === null) return null;
  return PACIFIC_DATE.format(new Date(seconds * 1000));
}

/** {"1": "<seconds>", "2": <nanos>} -> ISO datetime (UTC). */
export function timestampToIso(value: unknown): string | null {
  const seconds = num(obj(value)?.["1"]);
  if (seconds === null) return null;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 20260924 -> "2026-09-24". */
export function ymdToDate(value: unknown): string | null {
  const n = num(value);
  if (n === null || n < 19000101) return null;
  const s = String(Math.trunc(n));
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** "2026-09-24" -> 20260924, optionally shifted by whole days. */
export function dateToYmd(date: string, shiftDays = 0): number {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw new GatcError("INVALID_INPUT", `Invalid date "${date}". Use an existing calendar date, YYYY-MM-DD.`);
  }
  d.setUTCDate(d.getUTCDate() + shiftDays);
  return Number(d.toISOString().slice(0, 10).replaceAll("-", ""));
}

export function parseRange(lower: unknown, upper: unknown): Range | null {
  const up = num(upper);
  if (up === null) return null;
  return { lower: num(lower) ?? 0, upper: up };
}

/** `<img src="…" height="114" width="348">` -> image preview. */
export function parseImgTag(html: string): { url: string; width?: number; height?: number } | null {
  const src = /src="([^"]+)"/.exec(html)?.[1];
  if (!src) return null;
  const width = num(/width="(\d+)"/.exec(html)?.[1]);
  const height = num(/height="(\d+)"/.exec(html)?.[1]);
  return { url: src.replaceAll("&amp;", "&"), ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

export function creativeUrl(advertiserId: string, creativeId: string, regionCode: string): string {
  return `${ATC_ORIGIN}/advertiser/${advertiserId}/creative/${creativeId}?region=${regionCode}`;
}

export function parseSuggestions(json: Json): Suggestions {
  const advertisers: Suggestions["advertisers"] = [];
  const domains: string[] = [];
  for (const item of arr(json["1"])) {
    const entry = obj(item);
    const adv = obj(entry?.["1"]);
    const dom = obj(entry?.["2"]);
    if (adv) {
      const id = str(adv["2"]);
      if (!id) continue;
      const count = obj(obj(adv["4"])?.["2"]);
      advertisers.push({
        advertiser_id: id,
        name: str(adv["1"]) ?? id,
        country: str(adv["3"]),
        ads_count: count ? parseRange(count["1"], count["2"]) : null,
      });
    } else if (dom) {
      const d = str(dom["1"]);
      if (d) domains.push(d);
    }
  }
  return { advertisers, domains };
}

export function parseAdvertiser(json: Json): Advertiser {
  const a = obj(json["1"]);
  const id = str(a?.["1"]);
  if (!a || !id) throw new GatcError("NOT_FOUND", "Advertiser not found.");
  const identity = obj(a["9"]);
  return {
    advertiser_id: id,
    name: str(a["2"]) ?? id,
    legal_name: str(identity?.["1"]),
    disclosed_name: str(identity?.["2"]),
    country: str(a["3"]),
    location: str(a["11"]),
    identity_verified: num(identity?.["4"]) === 1,
  };
}

function parsePreview(content: unknown): Preview | null {
  const c = obj(content);
  if (!c) return null;
  const html = str(obj(c["3"])?.["2"]);
  if (html) {
    const img = parseImgTag(html);
    if (img) return { kind: "image", image_url: img.url, ...(img.width ? { width: img.width } : {}), ...(img.height ? { height: img.height } : {}) };
  }
  const render = str(obj(c["1"])?.["4"]);
  if (render) return { kind: "render", render_url: render };
  return null;
}

export function parseCreativeSummary(raw: unknown, regionCode: string): CreativeSummary | null {
  const c = obj(raw);
  const advertiserId = str(c?.["1"]);
  const creativeId = str(c?.["2"]);
  if (!c || !advertiserId || !creativeId) return null;
  return {
    advertiser_id: advertiserId,
    advertiser_name: str(c["12"]) ?? advertiserId,
    creative_id: creativeId,
    format: FORMAT_BY_CODE[num(c["4"]) ?? -1] ?? "unknown",
    first_shown: timestampToDate(c["6"]),
    last_shown: timestampToDate(c["7"]),
    days_shown: num(c["13"]),
    domain: str(c["14"]),
    preview: parsePreview(c["3"]),
    url: creativeUrl(advertiserId, creativeId, regionCode),
  };
}

export function parseCreativePage(json: Json, regionCode: string): CreativePage {
  if (json["1"] !== undefined && !Array.isArray(json["1"])) {
    throw new GatcError("UPSTREAM_CHANGED", "SearchCreatives field 1 is not a list");
  }
  const creatives = arr(json["1"])
    .map((c) => parseCreativeSummary(c, regionCode))
    .filter((c): c is CreativeSummary => c !== null);
  return {
    creatives,
    next_cursor: str(json["2"]),
    total_estimate: parseRange(json["4"], json["5"]),
  };
}

function parsePlatformStats(value: unknown): PlatformImpressions[] {
  const out: PlatformImpressions[] = [];
  for (const item of arr(value)) {
    const p = obj(item);
    const impressions = parseRange(p?.["2"], p?.["3"]);
    if (!p || !impressions) continue;
    out.push({ platform: PLATFORM_BY_CODE[num(p["1"]) ?? -1] ?? "unknown", impressions });
  }
  return out.sort((a, b) => b.impressions.upper - a.impressions.upper);
}

/** Impression reporting starts on 2023-03-01; earlier first-shown dates are clipped to it. */
export const REPORTING_START = "2023-03-01";

function parseStatsBlock(s: Json): Omit<RegionStats, "region_code" | "region_name"> {
  const firstShown = ymdToDate(s["4"]);
  const countedSince = ymdToDate(s["7"]);
  return {
    // Field 4 is omitted for ads older than the reporting window; field 7 then holds the clipped start.
    first_shown: firstShown ?? countedSince,
    first_shown_clipped: firstShown === null && countedSince === REPORTING_START,
    last_shown: ymdToDate(s["5"]),
    impressions: parseRange(s["2"], s["3"]),
    impressions_counted_since: countedSince,
    impressions_available_from: ymdToDate(s["6"]),
    impressions_by_platform: parsePlatformStats(s["8"]),
  };
}

function audienceUse(value: unknown): AudienceUse {
  const v = obj(value);
  if (!v) return "unused";
  const included = v["1"] === true;
  const excluded = v["2"] === true;
  if (included && excluded) return "included_and_excluded";
  if (included) return "included";
  if (excluded) return "excluded";
  return "unused";
}

function parseAudience(value: unknown): Record<AudienceCategory, AudienceUse> | null {
  const block = obj(obj(value)?.["4"]);
  if (!block) return null;
  const out = Object.fromEntries(AUDIENCE_CATEGORIES.map((c) => [c, "unused" as AudienceUse])) as Record<AudienceCategory, AudienceUse>;
  for (const [key, category] of Object.entries(AUDIENCE_KEYS)) {
    out[category as AudienceCategory] = audienceUse(block[key]);
  }
  return out;
}

function topicLabel(id: number, lang: Lang): string {
  const label = VERTICAL_TOPICS[id] ?? PRODUCT_CATEGORY_TOPICS[id];
  return label ? label[lang] : `Topic ${id}`;
}

function parseVariant(raw: unknown): CreativeVariant | null {
  const preview = parsePreview(raw);
  if (!preview) return null;
  return { ...preview };
}

export function parseCreativeDetail(json: Json, regionCode: string, lang: Lang): CreativeDetail {
  const c = obj(json["1"]);
  const advertiserId = str(c?.["1"]);
  const creativeId = str(c?.["2"]);
  if (!c || !advertiserId || !creativeId) throw new GatcError("NOT_FOUND", "Creative not found.");
  const topicId = num(obj(obj(c["16"])?.["1"])?.["1"]);
  const regions: RegionStats[] = [];
  for (const item of arr(c["17"])) {
    const s = obj(item);
    const id = num(s?.["1"]);
    if (!s || id === null) continue;
    const region = regionFromId(id, lang);
    regions.push({ region_code: region.code, region_name: region.name, ...parseStatsBlock(s) });
  }
  regions.sort(
    (a, b) =>
      (b.impressions?.upper ?? -1) - (a.impressions?.upper ?? -1) || (b.last_shown ?? "").localeCompare(a.last_shown ?? ""),
  );
  const totalsRaw = obj(c["19"]);
  return {
    advertiser_id: advertiserId,
    advertiser_name: str(obj(c["22"])?.["1"]),
    creative_id: creativeId,
    format: FORMAT_BY_CODE[num(c["8"]) ?? -1] ?? "unknown",
    last_shown_at: timestampToIso(c["4"]),
    topic: topicId !== null ? { id: topicId, label: topicLabel(topicId, lang) } : null,
    audience_selection: parseAudience(c["13"]),
    totals: totalsRaw ? parseStatsBlock(totalsRaw) : null,
    regions,
    variants: arr(c["5"])
      .map(parseVariant)
      .filter((v): v is CreativeVariant => v !== null),
    url: creativeUrl(advertiserId, creativeId, regionCode),
  };
}
