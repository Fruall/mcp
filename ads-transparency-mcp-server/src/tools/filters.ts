import type { CreativeFormat, Platform } from "../constants.js";
import { normalizeDomain, ADVERTISER_ID_RE, type CreativeFilters } from "../services/atc.js";
import { GatcError } from "../services/errors.js";
import { resolveRegion } from "../services/regions.js";

export interface FilterInput {
  advertiser_ids?: string[];
  domain?: string;
  region?: string;
  format?: CreativeFormat;
  platform?: Platform;
  date_from?: string;
  date_to?: string;
}

export function toFilters(input: FilterInput, defaultRegion: string): CreativeFilters {
  if (!input.domain && !input.advertiser_ids?.length) {
    throw new GatcError(
      "INVALID_INPUT",
      "Provide `advertiser_ids` (AR…) or a `domain`. Use gatc_search_advertisers to find the advertiser IDs of a brand.",
    );
  }
  return {
    ...(input.advertiser_ids?.length ? { advertiserIds: [...new Set(input.advertiser_ids)] } : {}),
    ...(input.domain ? { domain: normalizeDomain(input.domain) } : {}),
    region: resolveRegion(input.region, defaultRegion),
    ...(input.format ? { format: input.format } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.date_from ? { dateFrom: input.date_from } : {}),
    ...(input.date_to ? { dateTo: input.date_to } : {}),
  };
}

/** A target is either an advertiser ID or a domain. */
export function targetToFilters(target: string, base: Omit<FilterInput, "advertiser_ids" | "domain">, defaultRegion: string) {
  const t = target.trim();
  if (ADVERTISER_ID_RE.test(t)) return toFilters({ ...base, advertiser_ids: [t] }, defaultRegion);
  if (/^AR\d+$/i.test(t)) throw new GatcError("INVALID_INPUT", `"${t}" is not a complete advertiser ID.`);
  if (!t.includes(".")) {
    throw new GatcError(
      "INVALID_INPUT",
      `"${t}" is neither an advertiser ID nor a domain. Resolve brand names first with gatc_search_advertisers.`,
    );
  }
  return toFilters({ ...base, domain: t }, defaultRegion);
}

export function describeFilters(f: CreativeFilters): string {
  const parts: string[] = [];
  if (f.domain) parts.push(`domain ${f.domain}`);
  if (f.advertiserIds?.length) parts.push(`advertiser${f.advertiserIds.length > 1 ? "s" : ""} ${f.advertiserIds.join(", ")}`);
  parts.push(`region ${f.region.code}`);
  if (f.format) parts.push(`format ${f.format}`);
  if (f.platform) parts.push(`platform ${f.platform}`);
  if (f.dateFrom || f.dateTo) parts.push(`shown ${f.dateFrom ?? "…"} → ${f.dateTo ?? "…"}`);
  return parts.join(" · ");
}
