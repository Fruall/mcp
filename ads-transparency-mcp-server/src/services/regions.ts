import { REGIONS } from "../data/regions.js";
import { GatcError } from "./errors.js";
import type { Lang } from "../i18n.js";

export interface ResolvedRegion {
  /** ISO 3166-1 alpha-2 code, or "anywhere". */
  code: string;
  /** Google Ads geo target ID, or null for "anywhere". */
  id: number | null;
}

const ANYWHERE = new Set(["anywhere", "any", "all", "global", "world", "worldwide", "*"]);

const BY_ID = new Map<number, string>(Object.entries(REGIONS).map(([code, info]) => [info.id, code]));

export function resolveRegion(input: string | undefined, fallback: string): ResolvedRegion {
  const raw = (input ?? fallback).trim();
  if (ANYWHERE.has(raw.toLowerCase())) return { code: "anywhere", id: null };
  const upper = raw.toUpperCase() === "UK" ? "GB" : raw.toUpperCase();
  const info = REGIONS[upper];
  if (info) return { code: upper, id: info.id };
  if (/^\d{4,5}$/.test(raw)) {
    const code = BY_ID.get(Number(raw));
    if (code) return { code, id: Number(raw) };
  }
  throw new GatcError(
    "INVALID_INPUT",
    `Unknown region "${raw}". Use an ISO 3166-1 alpha-2 country code (e.g. "FR", "DE", "GB", "US") or "anywhere".`,
  );
}

export function regionFromId(id: number, lang: Lang): { code: string; name: string } {
  const code = BY_ID.get(id);
  if (!code) return { code: String(id), name: `Region ${id}` };
  const info = REGIONS[code];
  return { code, name: info ? info[lang] : code };
}

export function regionName(code: string, lang: Lang): string {
  if (code === "anywhere") return lang === "fr" ? "Toutes les régions" : "Anywhere";
  return REGIONS[code]?.[lang] ?? code;
}
