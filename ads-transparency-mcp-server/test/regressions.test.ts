// Regression tests for the issues found in code review.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EXPORT_NAME_RE } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { AtcService } from "../src/services/atc.js";
import { TtlCache } from "../src/services/cache.js";
import { HttpClient, type FetchLike } from "../src/services/http.js";
import { dateToYmd, parseCreativeDetail } from "../src/services/parsers.js";
import { createDeps, createServer } from "../src/server.js";
import { fitList } from "../src/tools/common.js";
import { creativeJson } from "../src/tools/creatives.js";
import { fixtureJson, mockFetch, type RecordedCall } from "./helpers.js";

async function connect(fetchImpl: FetchLike, env: Record<string, string> = {}) {
  const exportDir = mkdtempSync(path.join(os.tmpdir(), "gatc-reg-"));
  const config = loadConfig({ GATC_EXPORT_DIR: exportDir, GATC_MIN_INTERVAL_MS: "0", ...env }, []);
  const server = createServer(createDeps(config, fetchImpl));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call };
}

const text = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");

/** A fetch that serves endless pages of synthetic creatives with long names. */
function bigFetch(calls: RecordedCall[]): FetchLike {
  let page = 0;
  return async (input, init) => {
    const url = String(input);
    const request = JSON.parse(decodeURIComponent(String(init?.body ?? "").replace(/^f\.req=/, ""))) as Record<string, unknown>;
    calls.push({ service: url, request });
    const size = Number(request["2"]);
    const items = Array.from({ length: size }, (_, i) => ({
      "1": "AR10288591614947360769",
      "2": `CR${String(page * 1000 + i).padStart(20, "0")}`,
      "3": { "3": { "2": `<img src="https://tpc.googlesyndication.com/archive/simgad/${1e15 + page * 1000 + i}" height="100" width="300">` } },
      "4": 1,
      "6": { "1": "1783667495" },
      "7": { "1": "1790753197" },
      "12": "A VERY LONG ADVERTISER LEGAL NAME FOR TESTING PURPOSES SAS",
      "13": 10,
      "14": "example-long-domain-name.fr",
    }));
    page++;
    return new Response(JSON.stringify({ "1": items, "2": `cursor-${page}`, "4": "9000", "5": "10000" }));
  };
}

describe("review regressions", () => {
  it("exports go past 2,000 rows", async () => {
    const calls: RecordedCall[] = [];
    const { call, client } = await connect(bigFetch(calls));
    const res = await call("gatc_export_creatives", { domain: "example.fr", max_rows: 2500 });
    assert.ok(!res.isError, text(res));
    assert.equal((res.structuredContent as { rows: number }).rows, 2500);
    await client.close();
  });

  it("export file names are served by the HTTP route", async () => {
    const { call, client } = await connect(mockFetch([]), { TRANSPORT: "http", PUBLIC_BASE_URL: "https://x.test" });
    const res = await call("gatc_export_creatives", { domain: "parcasterix.fr", max_rows: 3 });
    const data = res.structuredContent as { file: string; download_url: string };
    assert.match(path.basename(data.file), EXPORT_NAME_RE);
    assert.equal(data.download_url, `https://x.test/exports/${path.basename(data.file)}`);
    await client.close();
  });

  it("never returns a cursor that would skip rows hidden by the size limit", async () => {
    const { call, client } = await connect(bigFetch([]));
    for (const response_format of ["markdown", "json"]) {
      const res = await call("gatc_list_creatives", { domain: "example.fr", limit: 200, response_format });
      const data = res.structuredContent as { creatives: unknown[]; next_cursor: string | null; notes: string[] };
      assert.ok(text(res).length <= 25_000, `${response_format} fits`);
      if (data.creatives.length < 200) {
        assert.equal(data.next_cursor, null);
        assert.match(data.notes.join(" "), new RegExp(`limit=${data.creatives.length}`));
      } else {
        assert.ok(data.next_cursor);
      }
    }
    const md = await call("gatc_list_creatives", { domain: "example.fr", limit: 150 });
    assert.ok((md.structuredContent as { creatives: unknown[] }).creatives.length >= 100, "compact markdown fits 100+ long rows");
    await client.close();
  });

  it("fitList finds the largest prefix", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const res = fitList(items, (s) => "x".repeat(s.length * 10), 555);
    assert.equal(res.shown.length, 55);
  });

  it("creative JSON stays valid and keeps variants when there are many countries", () => {
    const raw = fixtureJson("creative_text_images_old.json") as { "1": { "17": Array<Record<string, unknown>> } };
    const template = raw["1"]["17"][2] as Record<string, unknown>;
    raw["1"]["17"] = Array.from({ length: 120 }, (_, i) => ({ ...template, "1": 2000 + i * 4 }));
    const data = creativeJson(parseCreativeDetail(raw, "FR", "fr"));
    const json = JSON.stringify(data);
    assert.ok(json.length <= 25_000);
    assert.equal((data.variants as unknown[]).length, 2);
    assert.equal(data.countries_total, 120);
    assert.match(String(data.regions_note), /more countries omitted/);
  });

  it("one unknown ID does not sink gatc_view_creatives", async () => {
    const { call, client } = await connect(mockFetch([]));
    const res = await call("gatc_view_creatives", {
      items: [
        { advertiser_id: "AR05322865601155170305", creative_id: "CR01344536737463926785" },
        { advertiser_id: "AR05322865601155170305", creative_id: "CR99999999999999999999" },
      ],
    });
    assert.ok(!res.isError, text(res));
    assert.match(text(res), /Retrouvez Toutes Nos Offres/);
    assert.match(text(res), /Error: not found/);
    await client.close();
  });

  it("classifies HTTP failures without pointless retries", async () => {
    let attempts = 0;
    const make = (status: number, body: string, type = "text/html") =>
      new AtcService(
        new HttpClient({
          fetchImpl: async () => {
            attempts++;
            return new Response(body, { status, headers: { "content-type": type } });
          },
          minIntervalMs: 0,
          concurrency: 1,
          timeoutMs: 1000,
          retries: 2,
        }),
        new TtlCache(),
        "fr",
      );
    attempts = 0;
    await assert.rejects(make(429, "<html>unusual traffic from your computer</html>").suggest("x"), /CAPTCHA/);
    assert.equal(attempts, 1, "CAPTCHA with 429 is not retried");
    attempts = 0;
    await assert.rejects(make(400, "bad request", "text/plain").suggest("x"), (e: { code?: string }) => e.code === "UPSTREAM_CHANGED");
    assert.equal(attempts, 1);
    attempts = 0;
    await assert.rejects(make(403, "forbidden", "text/plain").suggest("x"), (e: { code?: string }) => e.code === "ACCESS_DENIED");
    assert.equal(attempts, 1);
  });

  it("rejects impossible dates and relative export dirs are made absolute", () => {
    assert.throws(() => dateToYmd("2026-02-30"), /existing calendar date/);
    assert.ok(path.isAbsolute(loadConfig({ GATC_EXPORT_DIR: "exports" }, []).exportDir));
    assert.equal(loadConfig({ GATC_TIMEOUT_MS: "0" }, []).timeoutMs, 1000);
  });

  it("CSV cells cannot inject formulas", async () => {
    const evil: FetchLike = async (input, init) => {
      const res = await mockFetch([])(input, init);
      if (!String(input).includes("SearchCreatives")) return res;
      const json = (await res.json()) as { "1": Array<Record<string, unknown>> };
      json["1"] = json["1"].map((c) => ({ ...c, "12": '=HYPERLINK("http://evil","x")' }));
      return new Response(JSON.stringify(json));
    };
    const { call, client } = await connect(evil);
    const res = await call("gatc_export_creatives", { domain: "parcasterix.fr", max_rows: 2 });
    const csv = readFileSync((res.structuredContent as { file: string }).file, "utf8");
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/);
    await client.close();
  });
});
