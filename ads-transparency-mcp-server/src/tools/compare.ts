import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FORMAT_CODES, PLATFORM_CODES, type CreativeFormat, type Platform } from "../constants.js";
import type { CreativeFilters } from "../services/atc.js";
import { GatcError } from "../services/errors.js";
import { mapLimit } from "../services/limiter.js";
import { regionName } from "../services/regions.js";
import type { Range } from "../types.js";
import { READ_ONLY, daysAgo, errorResult, fmtRange, regionSchema, render, responseFormatSchema, today, type ToolContext } from "./common.js";
import { targetToFilters } from "./filters.js";

interface TargetRow {
  target: string;
  label: string;
  total: Range | null;
  last_30_days: Range | null;
  by_format: Record<CreativeFormat, Range | null>;
  by_platform: Record<Platform, Range | null>;
  error?: string;
}

export function registerCompareTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gatc_compare_advertisers",
    {
      title: "Compare the ad footprint of several advertisers or domains",
      description: `Side-by-side comparison of 2–6 targets (advertiser IDs "AR…" or landing-page domains) in one country: Google's estimated number of ads, how many were shown in the last 30 days, and the split by format (text, image, video) and platform (Search, YouTube, Shopping, Maps, Play).

About 10 lightweight queries per target, computed server-side and cached. Counts are Google's rounded ranges; platform counts overlap (one ad can run on several platforms).

Args:
  - targets (string[]): 2–6 advertiser IDs or domains, e.g. ["sncf-connect.com", "trainline.com", "AR05322865601155170305"].
  - region: ISO country code or "anywhere" (default: server default, usually FR).
  - date_from / date_to (YYYY-MM-DD, optional): restrict counts to ads shown in this window.
  - response_format: 'markdown' | 'json'.

Returns: { region, window, rows: [{ target, label, total, last_30_days, by_format, by_platform }] }.
Domain targets include every advertiser (agencies too) whose ads point to that domain; advertiser targets cover one account only.`,
      inputSchema: {
        targets: z.array(z.string().min(3).max(253)).min(2).max(6).describe("Advertiser IDs (AR…) or domains to compare."),
        region: regionSchema,
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Count only ads shown on or after this date."),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Count only ads shown on or before this date."),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ targets, region, date_from, date_to, response_format }) => {
      try {
        const base = {
          ...(region ? { region } : {}),
          ...(date_from ? { date_from } : {}),
          ...(date_to ? { date_to } : {}),
        };
        // Validate every target up front so a typo fails fast.
        const resolved = targets.map((t) => ({ target: t, filters: targetToFilters(t, base, ctx.config.defaultRegion) }));
        const regionCode = resolved[0]?.filters.region.code ?? ctx.config.defaultRegion;
        const rows = await mapLimit(resolved, 2, async ({ target, filters }) => buildRow(ctx, target, filters));
        const data = { region: regionCode, window: { date_from: date_from ?? null, date_to: date_to ?? null }, rows };
        return render(
          response_format,
          () => {
            const head = `# Ad footprint · ${regionName(regionCode, ctx.atc.lang)}${date_from || date_to ? ` · shown ${date_from ?? "…"} → ${date_to ?? "…"}` : " · all time"}`;
            const lines = [
              head,
              "",
              "| Target | Ads | Last 30 d | Text | Image | Video | Search | YouTube | Shopping | Maps | Play |",
              "|---|---|---|---|---|---|---|---|---|---|---|",
              ...rows.map((r) =>
                r.error
                  ? `| ${r.label} | error: ${r.error} | | | | | | | | | |`
                  : `| ${r.label} | ${fmtRange(r.total)} | ${fmtRange(r.last_30_days)} | ${fmtRange(r.by_format.text)} | ${fmtRange(r.by_format.image)} | ${fmtRange(r.by_format.video)} | ${fmtRange(r.by_platform.search)} | ${fmtRange(r.by_platform.youtube)} | ${fmtRange(r.by_platform.shopping)} | ${fmtRange(r.by_platform.maps)} | ${fmtRange(r.by_platform.play)} |`,
              ),
              "",
              "Google's rounded estimates. Platform counts overlap. Domain rows include every advertiser pointing to the domain.",
            ];
            return lines.join("\n");
          },
          data,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

async function buildRow(ctx: ToolContext, target: string, filters: CreativeFilters): Promise<TargetRow> {
  const formats = Object.keys(FORMAT_CODES) as CreativeFormat[];
  const platforms = Object.keys(PLATFORM_CODES) as Platform[];
  let label = filters.domain ?? target;
  try {
    if (filters.advertiserIds?.[0]) {
      const adv = await ctx.atc.getAdvertiser(filters.advertiserIds[0]);
      label = `${adv.name} (${adv.advertiser_id})`;
    }
    const [total, last30] = await Promise.all([
      ctx.atc.countCreatives(filters),
      ctx.atc.countCreatives({ ...filters, dateFrom: daysAgo(30), dateTo: today() }),
    ]);
    const formatCounts = await mapLimit(formats, 3, (format) => ctx.atc.countCreatives({ ...filters, format }));
    const platformCounts = await mapLimit(platforms, 3, (platform) => ctx.atc.countCreatives({ ...filters, platform }));
    return {
      target,
      label,
      total,
      last_30_days: last30,
      by_format: Object.fromEntries(formats.map((f, i) => [f, formatCounts[i] ?? null])) as Record<CreativeFormat, Range | null>,
      by_platform: Object.fromEntries(platforms.map((p, i) => [p, platformCounts[i] ?? null])) as Record<Platform, Range | null>,
    };
  } catch (error) {
    // A throttled Google fails every row: surface it as a tool error instead of a table of errors.
    if (error instanceof GatcError && error.code === "RATE_LIMITED") throw error;
    return {
      target,
      label,
      total: null,
      last_30_days: null,
      by_format: { text: null, image: null, video: null },
      by_platform: { play: null, maps: null, search: null, shopping: null, youtube: null },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
