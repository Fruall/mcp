import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createDeps, createServer } from "../src/server.js";
import { mockFetch, type RecordedCall } from "./helpers.js";

const exportDir = mkdtempSync(path.join(os.tmpdir(), "gatc-test-"));
const calls: RecordedCall[] = [];
let client: Client;

before(async () => {
  const config = { ...loadConfig({ GATC_EXPORT_DIR: exportDir, GATC_MIN_INTERVAL_MS: "0" }, []) };
  const server = createServer(createDeps(config, mockFetch(calls)));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function text(result: CallToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

describe("MCP server", () => {
  it("lists the tools with read-only annotations", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "gatc_compare_advertisers",
      "gatc_export_creatives",
      "gatc_get_advertiser",
      "gatc_get_creative",
      "gatc_list_creatives",
      "gatc_search_advertisers",
      "gatc_view_creatives",
    ]);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 200, `${tool.name} has a real description`);
      if (tool.name !== "gatc_export_creatives") assert.equal(tool.annotations?.readOnlyHint, true);
    }
  });

  it("gatc_search_advertisers", async () => {
    const res = await call("gatc_search_advertisers", { query: "sncf" });
    assert.ok(!res.isError);
    const t = text(res);
    assert.match(t, /\| SNCF Connect \| AR05322865601155170305 \| FR \| 5k–6k \|/);
    assert.match(t, /Domains: sncf\.com, sncf-connect\.com/);
    const json = await call("gatc_search_advertisers", { query: "sncf", limit: 1, response_format: "json" });
    assert.equal((json.structuredContent as { advertisers: unknown[] }).advertisers.length, 1);
  });

  it("gatc_get_advertiser computes the ad mix", async () => {
    calls.length = 0;
    const res = await call("gatc_get_advertiser", { advertiser_id: "AR10288591614947360769", region: "FR" });
    assert.ok(!res.isError, text(res));
    const data = res.structuredContent as { ads_total: unknown; by_format: Record<string, unknown>; by_platform: Record<string, unknown> };
    assert.deepEqual(data.ads_total, { lower: 500, upper: 600 });
    assert.ok(data.by_format.video && data.by_platform.youtube);
    const searches = calls.filter((c) => c.service === "SearchService/SearchCreatives");
    assert.equal(searches.length, 10); // total + last 30 days + 3 formats + 5 platforms
    assert.ok(searches.some((c) => JSON.stringify(c.request["3"]).includes('"14":[5]')));
    assert.match(text(res), /Identity verified by Google: yes/);
  });

  it("gatc_list_creatives with sorting and new_since", async () => {
    const res = await call("gatc_list_creatives", { domain: "www.parcasterix.fr", limit: 3, sort: "newest" });
    assert.ok(!res.isError, text(res));
    const t = text(res);
    assert.match(t, /Google estimate for these filters: 500–600 ads/);
    assert.match(t, /\| CR15749406145401323521 \| AR10288591614947360769 \| CARAT FRANCE SAS \| image \|/);
    const recent = await call("gatc_list_creatives", { domain: "parcasterix.fr", new_since: "2026-08-01", limit: 50, response_format: "json" });
    const data = recent.structuredContent as { creatives: Array<{ first_shown: string }>; scanned: number };
    assert.ok(data.creatives.length >= 1);
    assert.ok(data.creatives.every((c) => c.first_shown >= "2026-08-01"));
    const last = calls.filter((c) => c.service === "SearchService/SearchCreatives").at(-1);
    assert.equal((last?.request["3"] as Record<string, unknown>)["6"], 20260801);
  });

  it("rejects bad input with guidance", async () => {
    const res = await call("gatc_list_creatives", { region: "FR" });
    assert.equal(res.isError, true);
    assert.match(text(res), /gatc_search_advertisers/);
    const bad = await call("gatc_list_creatives", { domain: "sncf-connect.com", region: "France" });
    assert.match(text(bad), /ISO 3166-1/);
  });

  it("gatc_get_creative returns stats, text and images", async () => {
    const res = await call("gatc_get_creative", { advertiser_id: "AR05322865601155170305", creative_id: "CR01344536737463926785" });
    assert.ok(!res.isError, text(res));
    const t = text(res);
    assert.match(t, /Topic \(Google label\): Voyage et tourisme/);
    assert.match(t, /\*\*Retrouvez Toutes Nos Offres\*\*/);
    assert.match(t, /customer lists: included and excluded/);
    assert.match(t, /available from 2026-12-23/);
    const old = await call("gatc_get_creative", { advertiser_id: "AR05322865601155170305", creative_id: "CR10209869331177668609", max_images: 1 });
    assert.match(text(old), /\| France \(FR\) \| < 2023-03-01 \| 2026-09-30 \| 300k–350k \| search 250k–300k, youtube 2k–3k \|/);
    assert.equal(old.content.filter((c) => c.type === "image").length, 1);
  });

  it("gatc_get_creative resolves YouTube videos", async () => {
    const res = await call("gatc_get_creative", { advertiser_id: "AR10288591614947360769", creative_id: "CR16250029663726862337", response_format: "json" });
    const data = res.structuredContent as { variants: Array<{ youtube_video_id?: string }> };
    assert.equal(data.variants[0]?.youtube_video_id, "uNqXkzcoYxc");
    assert.equal(res.content.filter((c) => c.type === "image").length, 1);
  });

  it("gatc_get_creative handles unknown IDs", async () => {
    const res = await call("gatc_get_creative", { advertiser_id: "AR05322865601155170305", creative_id: "CR99999999999999999999" });
    assert.equal(res.isError, true);
    assert.match(text(res), /not found/);
  });

  it("gatc_get_advertiser handles unknown IDs", async () => {
    const res = await call("gatc_get_advertiser", { advertiser_id: "AR99999999999999999999" });
    assert.equal(res.isError, true);
    assert.match(text(res), /Advertiser not found/);
  });

  it("gatc_view_creatives returns one image per ad", async () => {
    const res = await call("gatc_view_creatives", { domain: "parcasterix.fr", limit: 5 });
    assert.ok(!res.isError, text(res));
    assert.equal(res.content.filter((c) => c.type === "image").length, 5);
    assert.match(text(res), /Video: https:\/\/www\.youtube\.com\/watch\?v=uNqXkzcoYxc/);
    const items = await call("gatc_view_creatives", {
      items: [{ advertiser_id: "AR05322865601155170305", creative_id: "CR01344536737463926785" }],
    });
    assert.match(text(items), /Text: Retrouvez Toutes Nos Offres \| www\.sncf-connect\.com\//);
  });

  it("gatc_compare_advertisers builds one row per target", async () => {
    const res = await call("gatc_compare_advertisers", { targets: ["parcasterix.fr", "AR10288591614947360769"] });
    assert.ok(!res.isError, text(res));
    const rows = (res.structuredContent as { rows: Array<{ label: string; error?: string }> }).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.label, "CARAT FRANCE SAS (AR10288591614947360769)");
    assert.ok(rows.every((r) => !r.error));
    const bad = await call("gatc_compare_advertisers", { targets: ["parcasterix.fr", "sncf"] });
    assert.equal(bad.isError, true);
  });

  it("gatc_export_creatives writes a CSV with details", async () => {
    const res = await call("gatc_export_creatives", { domain: "parcasterix.fr", max_rows: 6, include_details: true });
    assert.ok(!res.isError, text(res));
    const data = res.structuredContent as { file: string; rows: number };
    assert.equal(data.rows, 6);
    const csv = readFileSync(data.file, "utf8");
    const [header, ...lines] = csv.replace(/^﻿/, "").trim().split("\n");
    assert.match(header ?? "", /^advertiser_id,advertiser_name,creative_id,format,.*,topic,countries,region_impressions_lower/);
    assert.equal(lines.length, 6);
    const tooMany = await call("gatc_export_creatives", { domain: "parcasterix.fr", max_rows: 1000, include_details: true });
    assert.equal(tooMany.isError, true);
  });
});
