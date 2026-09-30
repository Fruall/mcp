import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AUDIENCE_CATEGORIES, MAX_EXPORT_ROWS } from "../constants.js";
import { GatcError } from "../services/errors.js";
import { mapLimit } from "../services/limiter.js";
import type { CreativeDetail, CreativeSummary } from "../types.js";
import { READ_ONLY, errorResult, filterShape, fmtRange, textResult, type ToolContext } from "./common.js";
import { summarize } from "./creatives.js";
import { describeFilters, toFilters } from "./filters.js";

const MAX_DETAIL_ROWS = 150;

type Row = Record<string, string | number | null>;

function baseRow(c: CreativeSummary): Row {
  return {
    advertiser_id: c.advertiser_id,
    advertiser_name: c.advertiser_name,
    creative_id: c.creative_id,
    format: c.format,
    first_shown: c.first_shown,
    last_shown: c.last_shown,
    days_shown: c.days_shown,
    domain: c.domain,
    preview_kind: c.preview?.kind ?? null,
    preview_image_url: c.preview?.image_url ?? null,
    transparency_url: c.url,
  };
}

function detailColumns(d: CreativeDetail | null, regionCode: string, failed: boolean): Row {
  const row: Row = {
    detail_status: failed ? "error" : d ? "ok" : "not_found",
    topic: d?.topic?.label ?? null,
    countries: d ? d.regions.length : null,
  };
  if (regionCode !== "anywhere") {
    const region = d?.regions.find((r) => r.region_code === regionCode);
    row.region_impressions_lower = region?.impressions?.lower ?? null;
    row.region_impressions_upper = region?.impressions?.upper ?? null;
  }
  row.total_impressions_lower = d?.totals?.impressions?.lower ?? null;
  row.total_impressions_upper = d?.totals?.impressions?.upper ?? null;
  row.variants = d ? d.variants.length : null;
  for (const category of AUDIENCE_CATEGORIES) {
    row[`audience_${category}`] = d?.audience_selection?.[category] ?? null;
  }
  return row;
}

function toCsv(rows: Row[]): string {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0] as Row);
  const escape = (value: string | number | null) => {
    if (value === null || value === undefined) return "";
    let s = String(value);
    // Neutralise spreadsheet formulas in text cells (advertiser names come from third parties).
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return `﻿${[columns.join(","), ...rows.map((r) => columns.map((c) => escape(r[c] ?? null)).join(","))].join("\n")}\n`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "export";
}

export function registerExportTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gatc_export_creatives",
    {
      title: "Export ads to a CSV or JSON file",
      description: `Exports every ad matching the filters (same filters as gatc_list_creatives) to a CSV or JSON file, paginating through up to max_rows ads. Use it for full inventories, spreadsheets or datasets too large for the conversation.

With include_details=true each row is enriched with the ad's Google topic, number of countries, impression ranges (selected country and all countries) and audience-selection criteria. This costs one extra query per ad, so it is capped at ${MAX_DETAIL_ROWS} rows (about a minute). Large exports report progress to clients that support it.

Args:
  - advertiser_ids or domain, region, format, platform, date_from, date_to: see gatc_list_creatives.
  - max_rows (1–${MAX_EXPORT_ROWS}, default 2000), file_format ('csv' default | 'json'), include_details (default false).

Returns: { file, download_url?, rows, total_estimate, summary }. In local (stdio) mode the file is written on this computer (GATC_EXPORT_DIR, default ~/gatc-exports); on a remote server a download link is returned when PUBLIC_BASE_URL is set.`,
      inputSchema: {
        ...filterShape,
        max_rows: z.number().int().min(1).max(MAX_EXPORT_ROWS).default(2000).describe("Maximum ads to export."),
        file_format: z.enum(["csv", "json"]).default("csv").describe("Output file format."),
        include_details: z.boolean().default(false).describe(`Add topic, impressions and audience columns (max ${MAX_DETAIL_ROWS} rows).`),
      },
      annotations: { ...READ_ONLY, readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input, extra) => {
      const progressToken = extra._meta?.progressToken;
      const progress = async (done: number, total: number, message: string) => {
        if (progressToken === undefined) return;
        await extra
          .sendNotification({ method: "notifications/progress", params: { progressToken, progress: done, total, message } })
          .catch(() => undefined);
      };
      try {
        const filters = toFilters(input, ctx.config.defaultRegion);
        if (input.include_details && input.max_rows > MAX_DETAIL_ROWS) {
          throw new GatcError(
            "INVALID_INPUT",
            `include_details is limited to ${MAX_DETAIL_ROWS} rows (one extra query per ad). Lower max_rows or disable include_details.`,
          );
        }
        const result = await ctx.atc.listCreatives(filters, {
          limit: input.max_rows,
          maxScan: input.max_rows,
          hardCap: MAX_EXPORT_ROWS,
          onPage: (kept) => progress(kept, input.max_rows, `Listed ${kept} ads`),
        });
        let rows: Row[] = result.creatives.map(baseRow);
        if (input.include_details) {
          let done = 0;
          const details = await mapLimit(result.creatives, 2, async (c) => {
            try {
              return { detail: await ctx.atc.getCreative(c.advertiser_id, c.creative_id, filters.region), failed: false };
            } catch (error) {
              if (error instanceof GatcError && (error.code === "RATE_LIMITED" || error.code === "ACCESS_DENIED")) throw error;
              return { detail: null, failed: !(error instanceof GatcError && error.code === "NOT_FOUND") };
            } finally {
              done++;
              await progress(done, result.creatives.length, `Details ${done}/${result.creatives.length}`);
            }
          });
          rows = rows.map((row, i) => ({ ...row, ...detailColumns(details[i]?.detail ?? null, filters.region.code, details[i]?.failed ?? false) }));
        }
        const target = filters.domain ?? filters.advertiserIds?.join("-") ?? "ads";
        const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).toLowerCase();
        const name = `gatc_${slug(target)}_${filters.region.code.toLowerCase()}_${stamp}_${randomBytes(4).toString("hex")}.${input.file_format}`;
        await mkdir(ctx.config.exportDir, { recursive: true });
        const file = path.join(ctx.config.exportDir, name);
        const body = input.file_format === "csv" ? toCsv(rows) : JSON.stringify(rows, null, 2);
        await writeFile(file, body, "utf8");
        const downloadUrl = ctx.config.transport === "http" && ctx.config.publicBaseUrl ? `${ctx.config.publicBaseUrl}/exports/${name}` : null;
        const summary = summarize(result.creatives);
        const data = {
          filters: describeFilters(filters),
          file,
          ...(downloadUrl ? { download_url: downloadUrl } : {}),
          rows: rows.length,
          total_estimate: result.total_estimate,
          complete: result.next_cursor === null,
          summary,
        };
        const lines = [
          `Exported ${rows.length} ads (${describeFilters(filters)}).`,
          downloadUrl ? `Download: ${downloadUrl}` : `File: ${file}`,
          `Google estimate for these filters: ${fmtRange(result.total_estimate)}.${result.next_cursor ? ` More ads exist beyond max_rows=${input.max_rows} (maximum ${MAX_EXPORT_ROWS}); narrow the filters (dates, format, platform) to cover the rest.` : ""}`,
          `By format: ${Object.entries(summary.by_format).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
        ];
        return textResult(lines.join("\n"), data);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
