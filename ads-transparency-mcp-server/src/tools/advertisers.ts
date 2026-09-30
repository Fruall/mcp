import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FORMAT_CODES, PLATFORM_CODES, type CreativeFormat, type Platform } from "../constants.js";
import { mapLimit } from "../services/limiter.js";
import { resolveRegion, regionName } from "../services/regions.js";
import type { Range } from "../types.js";
import {
  READ_ONLY,
  advertiserIdSchema,
  daysAgo,
  errorResult,
  escapeCell,
  fmtRange,
  regionSchema,
  render,
  responseFormatSchema,
  today,
  type ToolContext,
} from "./common.js";

export function registerAdvertiserTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gatc_search_advertisers",
    {
      title: "Search advertisers in Google Ads Transparency Center",
      description: `Find Google Ads advertisers (and ad-landing domains) matching a brand, company or domain name. This is the entry point: every other tool needs an advertiser ID ("AR…") or a domain.

A brand frequently runs ads under several advertiser accounts (legal entities, agencies such as "CARAT FRANCE SAS", country subsidiaries): review all matches, not only the first.

Args:
  - query (string): brand, company or domain, e.g. "sncf", "Eurostar", "boursobank.com".
  - limit (number): max advertisers to return, 1–30 (default 15).
  - response_format: 'markdown' | 'json'.

Returns: { query, advertisers: [{ advertiser_id, name, country, ads_count: {lower, upper} }], domains: [string] }.
ads_count is Google's rounded all-regions estimate.

Examples:
  - "Which advertiser accounts does SNCF use?" -> query="sncf"
  - Then pass the IDs or a domain to gatc_list_creatives / gatc_get_advertiser.`,
      inputSchema: {
        query: z.string().min(2).max(200).describe("Brand, company or domain name to look up."),
        limit: z.number().int().min(1).max(30).default(15).describe("Maximum advertisers to return."),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit, response_format }) => {
      try {
        const result = await ctx.atc.suggest(query);
        const advertisers = result.advertisers.slice(0, limit);
        const data = { query, advertisers, domains: result.domains };
        return render(
          response_format,
          () => {
            if (!advertisers.length && !result.domains.length) {
              return `No advertiser or domain matches "${query}". Try a shorter brand name, the legal entity name, or the exact domain.`;
            }
            const lines = [`# Advertisers matching "${query}"`, ""];
            if (advertisers.length) {
              lines.push("| Advertiser | ID | Country | Ads (all regions, estimate) |", "|---|---|---|---|");
              for (const a of advertisers) {
                lines.push(`| ${escapeCell(a.name)} | ${a.advertiser_id} | ${a.country ?? ""} | ${fmtRange(a.ads_count)} |`);
              }
            } else {
              lines.push("No advertiser account matches this name.");
            }
            if (result.domains.length) lines.push("", `Domains: ${result.domains.join(", ")}`);
            lines.push("", "Next: gatc_get_advertiser for a profile, gatc_list_creatives with advertiser_ids or domain for the ads.");
            return lines.join("\n");
          },
          data,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "gatc_get_advertiser",
    {
      title: "Advertiser profile and ad mix",
      description: `Profile of one advertiser (legal name, location, identity verification) plus Google's estimate of how many ads it runs in a region, broken down by format (text, image, video) and platform (Search, YouTube, Shopping, Maps, Play), and how many were shown in the last 30 days.

Counts are Google's rounded estimates ("4000–5000"), computed server-side from about 10 lightweight queries (cached 30 min).

Args:
  - advertiser_id (string): "AR…" ID from gatc_search_advertisers.
  - region (string): ISO country code or "anywhere" (default: server default, usually FR).
  - date_from / date_to (YYYY-MM-DD, optional): restrict all counts to ads shown in this window.
  - include_breakdown (boolean): format and platform breakdown (default true).
  - response_format: 'markdown' | 'json'.

Returns: { advertiser: {...}, region, window, ads_total, shown_last_30_days, by_format: {text,image,video}, by_platform: {search,youtube,shopping,maps,play} } — each count is {lower, upper}.
Note: a creative can appear on several platforms, so platform counts do not add up to the total.`,
      inputSchema: {
        advertiser_id: advertiserIdSchema,
        region: regionSchema,
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Count only ads shown on or after this date."),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Count only ads shown on or before this date."),
        include_breakdown: z.boolean().default(true).describe("Include counts by format and platform."),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ advertiser_id, region, date_from, date_to, include_breakdown, response_format }) => {
      try {
        const reg = resolveRegion(region, ctx.config.defaultRegion);
        const base = {
          advertiserIds: [advertiser_id],
          region: reg,
          ...(date_from ? { dateFrom: date_from } : {}),
          ...(date_to ? { dateTo: date_to } : {}),
        };
        const [advertiser, total, last30] = await Promise.all([
          ctx.atc.getAdvertiser(advertiser_id),
          ctx.atc.countCreatives(base),
          ctx.atc.countCreatives({ ...base, dateFrom: daysAgo(30), dateTo: today() }),
        ]);
        let byFormat: Record<string, Range | null> | undefined;
        let byPlatform: Record<string, Range | null> | undefined;
        if (include_breakdown) {
          const formats = Object.keys(FORMAT_CODES) as CreativeFormat[];
          const platforms = Object.keys(PLATFORM_CODES) as Platform[];
          const formatCounts = await mapLimit(formats, 3, (format) => ctx.atc.countCreatives({ ...base, format }));
          const platformCounts = await mapLimit(platforms, 3, (platform) => ctx.atc.countCreatives({ ...base, platform }));
          byFormat = Object.fromEntries(formats.map((f, i) => [f, formatCounts[i] ?? null]));
          byPlatform = Object.fromEntries(platforms.map((p, i) => [p, platformCounts[i] ?? null]));
        }
        const data = {
          advertiser,
          region: reg.code,
          window: { date_from: date_from ?? null, date_to: date_to ?? null },
          ads_total: total,
          shown_last_30_days: last30,
          ...(byFormat ? { by_format: byFormat } : {}),
          ...(byPlatform ? { by_platform: byPlatform } : {}),
          transparency_url: `https://adstransparency.google.com/advertiser/${advertiser_id}?region=${reg.code}`,
        };
        return render(
          response_format,
          () => {
            const lines = [
              `# ${advertiser.name} (${advertiser.advertiser_id})`,
              "",
              `- Legal name: ${advertiser.legal_name ?? "n/a"}`,
              `- Location: ${advertiser.location || advertiser.country ? `${regionName(advertiser.location ?? advertiser.country ?? "", ctx.atc.lang)} (${advertiser.location ?? advertiser.country})` : "n/a"}`,
              `- Identity verified by Google: ${advertiser.identity_verified ? "yes" : "no"}`,
              `- Region: ${regionName(reg.code, ctx.atc.lang)}${date_from || date_to ? ` · window ${date_from ?? "…"} → ${date_to ?? "…"}` : " · all time"}`,
              "",
              `**Ads (Google estimate): ${fmtRange(total)}** · shown in the last 30 days: ${fmtRange(last30)}`,
            ];
            if (byFormat && byPlatform) {
              lines.push(
                "",
                "| Format | Ads | | Platform | Ads |",
                "|---|---|---|---|---|",
                `| Text | ${fmtRange(byFormat.text)} | | Search | ${fmtRange(byPlatform.search)} |`,
                `| Image | ${fmtRange(byFormat.image)} | | YouTube | ${fmtRange(byPlatform.youtube)} |`,
                `| Video | ${fmtRange(byFormat.video)} | | Shopping | ${fmtRange(byPlatform.shopping)} |`,
                `| | | | Maps | ${fmtRange(byPlatform.maps)} |`,
                `| | | | Play | ${fmtRange(byPlatform.play)} |`,
                "",
                "A creative can run on several platforms: platform counts overlap.",
              );
            }
            lines.push("", `Transparency Center: ${data.transparency_url}`);
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
