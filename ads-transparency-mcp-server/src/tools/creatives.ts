import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CHARACTER_LIMIT, MAX_INLINE_IMAGE_BYTES, MAX_INLINE_IMAGES, MAX_SCAN } from "../constants.js";
import { AtcService, type InlineImage } from "../services/atc.js";
import { mapLimit } from "../services/limiter.js";
import { GatcError } from "../services/errors.js";
import { creativeUrl, dateToYmd } from "../services/parsers.js";
import { resolveRegion, regionName } from "../services/regions.js";
import type { CreativeDetail, CreativeSummary, CreativeVariant } from "../types.js";
import {
  READ_ONLY,
  advertiserIdSchema,
  creativeIdSchema,
  errorResult,
  escapeCell,
  filterShape,
  fitList,
  fmtRange,
  regionSchema,
  render,
  responseFormatSchema,
  textResult,
  type ToolContext,
} from "./common.js";
import { describeFilters, toFilters } from "./filters.js";

const SORTS = ["api", "newest", "oldest", "longest_running", "recently_shown"] as const;
type Sort = (typeof SORTS)[number];

export function sortCreatives(list: CreativeSummary[], sort: Sort): CreativeSummary[] {
  const copy = [...list];
  const by = (key: "first_shown" | "last_shown", dir: 1 | -1) => (a: CreativeSummary, b: CreativeSummary) =>
    dir * (a[key] ?? "").localeCompare(b[key] ?? "");
  switch (sort) {
    case "newest":
      return copy.sort(by("first_shown", -1));
    case "oldest":
      return copy.sort(by("first_shown", 1));
    case "longest_running":
      return copy.sort((a, b) => (b.days_shown ?? 0) - (a.days_shown ?? 0));
    case "recently_shown":
      return copy.sort(by("last_shown", -1));
    default:
      return copy;
  }
}

export function summarize(list: CreativeSummary[]) {
  const byFormat: Record<string, number> = {};
  const advertisers = new Map<string, { advertiser_id: string; name: string; count: number }>();
  let firstMin: string | null = null;
  let lastMax: string | null = null;
  for (const c of list) {
    byFormat[c.format] = (byFormat[c.format] ?? 0) + 1;
    const a = advertisers.get(c.advertiser_id) ?? { advertiser_id: c.advertiser_id, name: c.advertiser_name, count: 0 };
    a.count++;
    advertisers.set(c.advertiser_id, a);
    if (c.first_shown && (!firstMin || c.first_shown < firstMin)) firstMin = c.first_shown;
    if (c.last_shown && (!lastMax || c.last_shown > lastMax)) lastMax = c.last_shown;
  }
  return {
    by_format: byFormat,
    advertisers: [...advertisers.values()].sort((a, b) => b.count - a.count),
    first_shown_min: firstMin,
    last_shown_max: lastMax,
  };
}

/** Row shape used in listings: the ad page URL is derivable, so it is given once as a template. */
export function compactRow(c: CreativeSummary) {
  return {
    creative_id: c.creative_id,
    advertiser_id: c.advertiser_id,
    advertiser_name: c.advertiser_name,
    format: c.format,
    first_shown: c.first_shown,
    last_shown: c.last_shown,
    days_shown: c.days_shown,
    domain: c.domain,
    preview: c.preview?.kind ?? null,
    ...(c.preview?.image_url ? { preview_image_url: c.preview.image_url } : {}),
  };
}

function variantLine(v: CreativeVariant, index: number): string {
  const parts = [`${index + 1}.`];
  if (v.text) {
    parts.push(
      [v.text.headline && `**${v.text.headline}**`, v.text.display_url, v.text.description].filter(Boolean).join(" · "),
    );
  }
  if (v.youtube_url) parts.push(`YouTube: ${v.youtube_url}`);
  if (v.image_url) parts.push(`image ${v.width ?? "?"}×${v.height ?? "?"}: ${v.image_url}`);
  if (!v.text && !v.youtube_url && !v.image_url && v.asset_images?.length) parts.push(`assets: ${v.asset_images.join(", ")}`);
  if (parts.length === 1) parts.push("interactive preview only (open the Transparency Center link)");
  return parts.join(" ");
}

async function collectImages(
  atc: AtcService,
  entries: Array<{ label: string; url: string | null }>,
  max: number,
): Promise<Array<{ label: string; image: InlineImage | null; url: string | null }>> {
  const picked = entries.slice(0, max);
  return mapLimit(picked, 4, async (entry) => {
    if (!entry.url) return { ...entry, image: null };
    try {
      return { ...entry, image: await atc.fetchImage(entry.url, MAX_INLINE_IMAGE_BYTES) };
    } catch {
      return { ...entry, image: null };
    }
  });
}

export function registerCreativeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gatc_list_creatives",
    {
      title: "List ads (creatives) of an advertiser or domain",
      description: `List the ads Google shows for one or more advertisers or for a landing-page domain, with filters on country, format, platform and date. Paginates automatically up to \`limit\`.

Each row: creative_id, advertiser, format, first_shown, last_shown, days_shown, domain, preview image URL (search ads are served as a rendered image of the ad) and the Transparency Center link.

Args:
  - advertiser_ids (string[]) or domain (string): the target (at least one).
  - region: ISO country code or "anywhere" (default: server default, usually FR).
  - format: 'text' | 'image' | 'video'. platform: 'search' | 'youtube' | 'shopping' | 'maps' | 'play'.
  - date_from / date_to (YYYY-MM-DD): ads shown during this window.
  - new_since (YYYY-MM-DD): keep only ads first shown on or after this date (new ads). Scans up to max_scan ads.
  - sort: 'api' (Google's order, default) | 'newest' | 'oldest' | 'longest_running' | 'recently_shown' — applies to the returned rows.
  - limit (1–200, default 50), cursor (from a previous call), max_scan (for new_since, default 1000).
  - response_format: 'markdown' | 'json'.

Returns: { filters, total_estimate: {lower, upper}, returned, scanned, next_cursor, notes, summary: {by_format, advertisers, first_shown_min, last_shown_max}, url_template, creatives: [{creative_id, advertiser_id, advertiser_name, format, first_shown, last_shown, days_shown, domain, preview, preview_image_url}] }.

To read what the ads say, pass creatives to gatc_view_creatives (returns the ad images). For thousands of rows use gatc_export_creatives.`,
      inputSchema: {
        ...filterShape,
        new_since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Keep only ads first shown on or after this date."),
        sort: z.enum(SORTS).default("api").describe("Order of the returned rows."),
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum ads to return (rows beyond the response size limit are dropped and reported)."),
        cursor: z.string().max(500).optional().describe("next_cursor from a previous call with the same filters."),
        max_scan: z.number().int().min(1).max(MAX_SCAN).default(1000).describe("Upper bound of ads paged through when new_since is set."),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const filters = toFilters(input, ctx.config.defaultRegion);
        const newSince = input.new_since;
        if (newSince) dateToYmd(newSince); // validates the date
        if (newSince && !filters.dateFrom) filters.dateFrom = newSince;
        const result = await ctx.atc.listCreatives(filters, {
          limit: input.limit,
          cursor: input.cursor ?? null,
          ...(newSince
            ? { predicate: (c: CreativeSummary) => (c.first_shown ?? "") >= newSince, maxScan: input.max_scan }
            : {}),
        });
        const creatives = sortCreatives(result.creatives, input.sort);
        const summary = summarize(creatives);
        const rows = creatives.map(compactRow);
        const regionCode = filters.region.code;
        const notes: string[] = [];
        if (newSince && result.next_cursor && result.creatives.length < input.limit) {
          notes.push(`Stopped after scanning ${result.scanned} ads (max_scan). Raise max_scan or pass next_cursor to continue.`);
        }
        if (newSince && result.next_cursor && result.creatives.length >= input.limit) {
          notes.push("Limit reached; with new_since, continuing from next_cursor may skip a few ads of the last page.");
        }
        const estimateLabel = newSince
          ? `Ads shown since ${filters.dateFrom} (Google estimate): ${fmtRange(result.total_estimate)}. New ads (first shown since ${newSince}) found: ${creatives.length}, after scanning ${result.scanned}.`
          : `Google estimate for these filters: ${fmtRange(result.total_estimate)} ads. Returned ${creatives.length}.`;
        const base = {
          filters: describeFilters(filters),
          total_estimate: result.total_estimate,
          ...(newSince ? { new_since: newSince } : {}),
          returned: creatives.length,
          scanned: result.scanned,
          summary,
          url_template: `https://adstransparency.google.com/advertiser/{advertiser_id}/creative/{creative_id}?region=${regionCode}`,
        };
        const withCursor = (shown: number) => {
          // Never hand out a cursor that would skip rows hidden by the size limit.
          if (shown < rows.length) {
            return {
              next_cursor: null,
              notes: [
                ...notes,
                `Only ${shown} of ${rows.length} rows fit in one response. Call again with limit=${shown} to page without gaps, or use gatc_export_creatives.`,
              ],
            };
          }
          return { next_cursor: result.next_cursor, notes };
        };
        if (input.response_format === "json") {
          const build = (subset: typeof rows) => ({ ...base, ...withCursor(subset.length), creatives: subset });
          const fitted = fitList(rows, (subset) => JSON.stringify(build(subset)));
          const data = build(fitted.shown);
          return textResult(JSON.stringify(data), data);
        }
        const header = [
          `# Ads · ${describeFilters(filters)}`,
          "",
          estimateLabel,
          `By format: ${Object.entries(summary.by_format).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}. ` +
            (summary.first_shown_min ? `First shown from ${summary.first_shown_min}, last shown up to ${summary.last_shown_max}.` : ""),
        ];
        if (summary.advertisers.length > 1) {
          header.push(`Advertisers: ${summary.advertisers.map((a) => `${a.name} (${a.advertiser_id}) ${a.count}`).join("; ")}`);
        }
        const table = (subset: typeof rows) =>
          [
            "| Creative | Advertiser ID | Advertiser | Format | First shown | Last shown | Days | Domain | Preview |",
            "|---|---|---|---|---|---|---|---|---|",
            ...subset.map(
              (r) =>
                `| ${r.creative_id} | ${r.advertiser_id} | ${escapeCell(r.advertiser_name)} | ${r.format} | ${r.first_shown ?? ""} | ${r.last_shown ?? ""} | ${r.days_shown ?? ""} | ${r.domain ?? ""} | ${r.preview ?? ""} |`,
            ),
          ].join("\n");
        const footerFor = (subset: typeof rows) => {
          const { next_cursor, notes: n } = withCursor(subset.length);
          const lines = [...n];
          if (next_cursor) lines.push(`More results: call again with cursor="${next_cursor}".`);
          lines.push(`Ad page: ${base.url_template}. See the ads themselves with gatc_view_creatives.`);
          return lines;
        };
        const renderMd = (subset: typeof rows) =>
          [...header, "", rows.length ? table(subset) : "No ads match these filters.", "", ...footerFor(subset)].join("\n");
        const fitted = fitList(rows, renderMd);
        return textResult(renderMd(fitted.shown), { ...base, ...withCursor(fitted.shown.length), creatives: fitted.shown });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "gatc_get_creative",
    {
      title: "Ad details: impressions, countries, audience, content",
      description: `Full detail of one ad: format, Google topic, first/last shown dates per country, impression ranges per country and per platform (EEA and Turkey only), the audience-selection criteria the advertiser used (demographics, locations, contextual signals, topics of interest, customer lists: included / excluded / unused), and every variant of the ad.

Variants carry, when available: the ad image, the search-ad text (headline, display URL, description) for the minority of ads Google exposes as text, the YouTube video ID for video ads, and asset images for display ads. With include_images=true (default) the variant images are returned inline so you can read the ad copy.

Args:
  - advertiser_id (string, "AR…"), creative_id (string, "CR…").
  - region: country used for the Transparency Center link (stats cover all countries).
  - include_images (boolean, default true), max_images (1–6, default 3).
  - response_format: 'markdown' | 'json'.

Returns: { advertiser_id, advertiser_name, creative_id, format, topic, audience_selection, totals, regions: [{region_code, first_shown, last_shown, impressions, impressions_by_platform, ...}], variants: [...], url } plus inline images.
Impressions are Google's rounded ranges, published with a delay of about 90 days; outside the EEA/Turkey only dates are available.
Dates here are limited to the reporting window that starts on 2023-03-01; the true first-shown date of older ads is in gatc_list_creatives.`,
      inputSchema: {
        advertiser_id: advertiserIdSchema,
        creative_id: creativeIdSchema,
        region: regionSchema,
        include_images: z.boolean().default(true).describe("Return the variant images inline."),
        max_images: z.number().int().min(1).max(6).default(3).describe("Maximum inline images."),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ advertiser_id, creative_id, region, include_images, max_images, response_format }) => {
      try {
        const reg = resolveRegion(region, ctx.config.defaultRegion);
        const detail = await ctx.atc.getCreative(advertiser_id, creative_id, reg);
        const variants = await ctx.atc.enrichVariants(detail.variants);
        const full: CreativeDetail = { ...detail, variants };
        const data = creativeJson(full);
        const result: CallToolResult =
          response_format === "json" ? textResult(JSON.stringify(data), data) : textResult(renderCreative(full), data);
        if (include_images) {
          const images = await collectImages(
            ctx.atc,
            variants.map((v, i) => ({ label: `Variant ${i + 1}`, url: AtcService.variantImageUrl(v) })).filter((e) => e.url),
            max_images,
          );
          for (const img of images) {
            if (!img.image) continue;
            result.content.push({ type: "text", text: `${img.label}:` });
            result.content.push({ type: "image", data: img.image.base64, mimeType: img.image.mimeType });
          }
        }
        return result;
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "gatc_view_creatives",
    {
      title: "View ads (images and text) to read their messaging",
      description: `Returns what several ads actually look like, so you can read their copy: one inline image per ad (search ads are rendered images of the text ad; video ads show the YouTube thumbnail) plus the extracted text or YouTube link when Google exposes it.

Two ways to choose the ads:
  1. items: [{advertiser_id, creative_id}] (1–12), e.g. picked from gatc_list_creatives;
  2. or the same filters as gatc_list_creatives (advertiser_ids or domain, region, format, platform, date_from, date_to) with limit (1–12): the first ads Google returns (most recently shown first).

Args:
  - items or filters (see above); limit (1–12, default 8).
  - response_format: 'markdown' | 'json' (applies to the text part; images are always inline).

Use it to analyse messaging, offers, CTAs or creative angles of a competitor. Images cost context: prefer small batches.`,
      inputSchema: {
        items: z
          .array(z.object({ advertiser_id: advertiserIdSchema, creative_id: creativeIdSchema }))
          .min(1)
          .max(MAX_INLINE_IMAGES)
          .optional()
          .describe("Explicit list of ads to view."),
        ...filterShape,
        limit: z.number().int().min(1).max(MAX_INLINE_IMAGES).default(8).describe("Number of ads to view when using filters."),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const reg = resolveRegion(input.region, ctx.config.defaultRegion);
        type Card = {
          advertiser_id: string;
          advertiser_name: string;
          creative_id: string;
          format: string;
          first_shown: string | null;
          last_shown: string | null;
          url: string;
          variant: CreativeVariant | null;
          image_url: string | null;
          error?: string;
        };
        let cards: Card[];
        if (input.items?.length) {
          cards = await mapLimit(input.items, 3, async (item): Promise<Card> => {
            let detail: CreativeDetail;
            try {
              detail = await ctx.atc.getCreative(item.advertiser_id, item.creative_id, reg);
            } catch (error) {
              // One bad ID must not sink the batch; throttling still aborts it.
              if (error instanceof GatcError && error.code !== "NOT_FOUND") throw error;
              return {
                advertiser_id: item.advertiser_id,
                advertiser_name: item.advertiser_id,
                creative_id: item.creative_id,
                format: "unknown",
                first_shown: null,
                last_shown: null,
                url: creativeUrl(item.advertiser_id, item.creative_id, reg.code),
                variant: null,
                image_url: null,
                error: "not found",
              };
            }
            const [variant] = await ctx.atc.enrichVariants(detail.variants.slice(0, 1));
            return {
              advertiser_id: detail.advertiser_id,
              advertiser_name: detail.advertiser_name ?? detail.advertiser_id,
              creative_id: detail.creative_id,
              format: detail.format,
              first_shown: detail.totals?.first_shown_clipped ? "before 2023-03-01" : (detail.totals?.first_shown ?? null),
              last_shown: detail.totals?.last_shown ?? null,
              url: detail.url,
              variant: variant ?? null,
              image_url: variant ? AtcService.variantImageUrl(variant) : null,
            };
          });
        } else {
          const filters = toFilters(input, ctx.config.defaultRegion);
          const list = await ctx.atc.listCreatives(filters, { limit: input.limit });
          cards = await mapLimit(list.creatives, 3, async (c) => {
            const raw: CreativeVariant | null = c.preview ? { ...c.preview } : null;
            const [variant] = raw ? await ctx.atc.enrichVariants([raw]) : [null];
            return {
              advertiser_id: c.advertiser_id,
              advertiser_name: c.advertiser_name,
              creative_id: c.creative_id,
              format: c.format,
              first_shown: c.first_shown,
              last_shown: c.last_shown,
              url: c.url,
              variant: variant ?? null,
              image_url: variant ? AtcService.variantImageUrl(variant) : null,
            };
          });
        }
        if (!cards.length) return textResult("No ads match these filters.", { cards: [] });

        const images = await collectImages(
          ctx.atc,
          cards.map((c) => ({ label: c.creative_id, url: c.image_url })),
          MAX_INLINE_IMAGES,
        );
        const structured = {
          region: reg.code,
          cards: cards.map((c, i) => ({
            ...c,
            image_returned: Boolean(images[i]?.image),
          })),
        };
        const result: CallToolResult = { content: [], structuredContent: structured };
        if (input.response_format === "json") {
          result.content.push({ type: "text", text: JSON.stringify(structured, null, 2) });
        } else {
          result.content.push({
            type: "text",
            text: `# ${cards.length} ads (${regionName(reg.code, ctx.atc.lang)})\nEach caption is followed by the ad image when one is available.`,
          });
        }
        cards.forEach((c, i) => {
          const v = c.variant;
          const bits = [`**${i + 1}. ${c.advertiser_name}** · ${c.format} · ${c.creative_id} · shown ${c.first_shown ?? "?"} → ${c.last_shown ?? "?"}`];
          if (v?.text) bits.push(`Text: ${[v.text.headline, v.text.display_url, v.text.description].filter(Boolean).join(" | ")}`);
          if (v?.youtube_url) bits.push(`Video: ${v.youtube_url}`);
          const img = images[i];
          if (c.error) bits.push(`Error: ${c.error} (check the IDs).`);
          else if (!img?.image) bits.push(v?.text || v?.youtube_url ? "" : `No image available: ${c.url}`);
          if (input.response_format === "markdown") result.content.push({ type: "text", text: bits.filter(Boolean).join("\n") });
          if (img?.image) result.content.push({ type: "image", data: img.image.base64, mimeType: img.image.mimeType });
        });
        return result;
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

const JSON_REGION_CAP = 25;

/** JSON view of a creative: ad content first, then stats; long country lists are trimmed rather than cut mid-object. */
export function creativeJson(d: CreativeDetail): Record<string, unknown> {
  const base = {
    advertiser_id: d.advertiser_id,
    advertiser_name: d.advertiser_name,
    creative_id: d.creative_id,
    format: d.format,
    url: d.url,
    last_shown_at: d.last_shown_at,
    topic: d.topic,
    variants: d.variants,
    audience_selection: d.audience_selection,
    totals: d.totals,
    countries_total: d.regions.length,
  };
  const cap = Math.min(JSON_REGION_CAP, d.regions.length);
  const shown = fitList(d.regions.slice(0, cap), (subset) => JSON.stringify({ ...base, regions: subset }), CHARACTER_LIMIT - 500).shown;
  return {
    ...base,
    regions: shown,
    ...(shown.length < d.regions.length
      ? { regions_note: `${d.regions.length - shown.length} more countries omitted (sorted by impressions, then last shown).` }
      : {}),
  };
}

function renderCreative(d: CreativeDetail): string {
  const lines = [
    `# Ad ${d.creative_id} · ${d.advertiser_name ?? d.advertiser_id}`,
    "",
    `- Advertiser: ${d.advertiser_name ?? ""} (${d.advertiser_id})`,
    `- Format: ${d.format}${d.topic ? ` · Topic (Google label): ${d.topic.label}` : ""}`,
    `- Last shown: ${d.last_shown_at ?? "n/a"}`,
  ];
  if (d.totals) {
    lines.push(
      `- All regions: first shown ${d.totals.first_shown_clipped ? "before 2023-03-01" : (d.totals.first_shown ?? "n/a")} · last shown ${d.totals.last_shown ?? "n/a"} · impressions ${
        d.totals.impressions ? fmtRange(d.totals.impressions) : d.totals.impressions_available_from ? `available from ${d.totals.impressions_available_from}` : "n/a"
      }`,
    );
    if (d.totals.impressions_by_platform.length) {
      lines.push(`- Impressions by platform: ${d.totals.impressions_by_platform.map((p) => `${p.platform} ${fmtRange(p.impressions)}`).join(", ")}`);
    }
  }
  if (d.audience_selection) {
    const a = d.audience_selection;
    lines.push(
      "",
      "**Audience selection** (criteria of the latest campaign)",
      ...Object.entries(a).map(([k, v]) => `- ${k.replaceAll("_", " ")}: ${v.replaceAll("_", " ")}`),
    );
  }
  if (d.regions.length) {
    const top = d.regions.slice(0, 15);
    lines.push(
      "",
      `**By country** (${d.regions.length} countries${d.regions.length > top.length ? `, top ${top.length} shown` : ""})`,
      "| Country | First shown | Last shown | Impressions | By platform |",
      "|---|---|---|---|---|",
      ...top.map(
        (r) =>
          `| ${r.region_name} (${r.region_code}) | ${r.first_shown_clipped ? "< 2023-03-01" : (r.first_shown ?? "")} | ${r.last_shown ?? ""} | ${
            r.impressions ? fmtRange(r.impressions) : r.impressions_available_from ? `from ${r.impressions_available_from}` : "n/a"
          } | ${r.impressions_by_platform.map((p) => `${p.platform} ${fmtRange(p.impressions)}`).join(", ")} |`,
      ),
    );
  }
  lines.push("", `**Variants** (${d.variants.length})`, ...d.variants.map(variantLine));
  lines.push("", `Transparency Center: ${d.url}`);
  lines.push(
    "",
    "Impressions are Google's rounded ranges, published about 90 days after delivery and only for EEA/Turkey countries. " +
      "Dates in this view start at 2023-03-01 (start of Google's reporting); gatc_list_creatives gives the true first-shown date of older ads.",
  );
  return lines.join("\n");
}
