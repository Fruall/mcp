import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CHARACTER_LIMIT } from "../constants.js";
import type { Config } from "../config.js";
import { ADVERTISER_ID_RE, CREATIVE_ID_RE, type AtcService } from "../services/atc.js";
import { describeError } from "../services/errors.js";
import type { Range } from "../types.js";

export interface ToolContext {
  atc: AtcService;
  config: Config;
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' (default) for a readable summary, 'json' for the full structured data.");

export const regionSchema = z
  .string()
  .min(1)
  .max(12)
  .optional()
  .describe(
    'Country where the ads were shown: ISO 3166-1 alpha-2 code ("FR", "DE", "GB", "US"...) or "anywhere". Defaults to the server default (usually FR).',
  );

export const advertiserIdSchema = z
  .string()
  .regex(ADVERTISER_ID_RE, 'Advertiser IDs look like "AR05322865601155170305".')
  .describe('Advertiser ID from the Transparency Center (starts with "AR").');

export const creativeIdSchema = z
  .string()
  .regex(CREATIVE_ID_RE, 'Creative IDs look like "CR01344536737463926785".')
  .describe('Creative (ad) ID from the Transparency Center (starts with "CR").');

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const filterShape = {
  advertiser_ids: z
    .array(advertiserIdSchema)
    .min(1)
    .max(20)
    .optional()
    .describe("One or more advertiser IDs (a brand often has several). Use this or `domain`."),
  domain: z
    .string()
    .min(3)
    .max(253)
    .optional()
    .describe('Landing-page domain, e.g. "sncf-connect.com". Returns ads from every advertiser pointing to it (agencies included).'),
  region: regionSchema,
  format: z.enum(["text", "image", "video"]).optional().describe("Ad format filter."),
  platform: z
    .enum(["search", "youtube", "shopping", "maps", "play"])
    .optional()
    .describe("Google surface filter. Display ads have no dedicated filter: leave empty and use format='image'."),
  date_from: dateSchema.optional().describe("Only ads shown on or after this date (YYYY-MM-DD)."),
  date_to: dateSchema.optional().describe("Only ads shown on or before this date (YYYY-MM-DD)."),
};

export function fmtNumber(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

export function fmtRange(range: Range | null | undefined): string {
  if (!range) return "n/a";
  if (range.lower === range.upper) return fmtNumber(range.upper);
  return `${fmtNumber(range.lower)}–${fmtNumber(range.upper)}`;
}

export function escapeCell(value: string | null | undefined): string {
  return (value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  const body = text.length > CHARACTER_LIMIT ? `${text.slice(0, CHARACTER_LIMIT)}\n\n[Truncated: response exceeded ${CHARACTER_LIMIT} characters. Narrow the filters or use gatc_export_creatives.]` : text;
  return {
    content: [{ type: "text", text: body }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: describeError(error) }], isError: true };
}

export function render(format: "markdown" | "json", markdown: () => string, data: Record<string, unknown>): CallToolResult {
  return textResult(format === "json" ? JSON.stringify(data, null, 2) : markdown(), data);
}

/** Largest prefix of `items` whose rendering fits under the character limit (binary search). */
export function fitList<T>(items: T[], renderAll: (subset: T[]) => string, limit = CHARACTER_LIMIT): { shown: T[]; truncated: boolean } {
  if (items.length === 0 || renderAll(items).length <= limit) return { shown: items, truncated: false };
  let lo = 1;
  let hi = items.length - 1;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (renderAll(items.slice(0, mid)).length <= limit) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { shown: items.slice(0, best), truncated: true };
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
