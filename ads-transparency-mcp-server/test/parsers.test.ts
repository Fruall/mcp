import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AtcService, normalizeDomain } from "../src/services/atc.js";
import { TtlCache } from "../src/services/cache.js";
import { extractAssetImages, parseRenderScript, unescapeJs } from "../src/services/content.js";
import { HttpClient } from "../src/services/http.js";
import {
  dateToYmd,
  parseAdvertiser,
  parseCreativeDetail,
  parseCreativePage,
  parseSuggestions,
  timestampToDate,
  ymdToDate,
} from "../src/services/parsers.js";
import { resolveRegion } from "../src/services/regions.js";
import { fixture, fixtureJson, mockFetch, type RecordedCall } from "./helpers.js";

describe("primitives", () => {
  it("converts timestamps and dates", () => {
    assert.equal(timestampToDate({ "1": "1790302618", "2": 924764000 }), "2026-09-24");
    assert.equal(ymdToDate(20260924), "2026-09-24");
    assert.equal(dateToYmd("2026-09-29", 1), 20260930);
    assert.equal(dateToYmd("2026-12-31", 1), 20270101);
  });

  it("resolves regions to Google geo IDs", () => {
    assert.deepEqual(resolveRegion("fr", "FR"), { code: "FR", id: 2250 });
    assert.deepEqual(resolveRegion("UK", "FR"), { code: "GB", id: 2826 });
    assert.deepEqual(resolveRegion(undefined, "DE"), { code: "DE", id: 2276 });
    assert.deepEqual(resolveRegion("anywhere", "FR"), { code: "anywhere", id: null });
    assert.throws(() => resolveRegion("France", "FR"), /ISO 3166-1/);
  });

  it("normalizes domains", () => {
    assert.equal(normalizeDomain("https://www.SNCF-Connect.com/app?x=1"), "sncf-connect.com");
    assert.throws(() => normalizeDomain("sncf"), /not a valid domain/);
  });
});

describe("RPC decoders", () => {
  it("parses suggestions", () => {
    const s = parseSuggestions(fixtureJson("suggestions_sncf.json"));
    assert.equal(s.advertisers.length, 3);
    assert.deepEqual(s.advertisers[1], {
      advertiser_id: "AR05322865601155170305",
      name: "SNCF Connect",
      country: "FR",
      ads_count: { lower: 5000, upper: 6000 },
    });
    assert.deepEqual(s.domains, ["sncf.com", "sncf-connect.com"]);
  });

  it("parses an advertiser", () => {
    const a = parseAdvertiser(fixtureJson("advertiser_carat.json"));
    assert.equal(a.name, "CARAT FRANCE SAS");
    assert.equal(a.identity_verified, true);
    assert.throws(() => parseAdvertiser({}), /not found/);
  });

  it("parses a creatives page", () => {
    const page = parseCreativePage(fixtureJson("search_parcasterix_fr.json"), "FR");
    assert.equal(page.creatives.length, 5);
    assert.deepEqual(page.total_estimate, { lower: 500, upper: 600 });
    assert.ok(page.next_cursor);
    const [first, , , , video] = page.creatives;
    assert.equal(first?.format, "text");
    assert.equal(first?.preview?.kind, "image");
    assert.equal(first?.preview?.image_url, "https://tpc.googlesyndication.com/archive/simgad/11909822060651937952");
    assert.equal(first?.days_shown, 82);
    assert.equal(first?.url, "https://adstransparency.google.com/advertiser/AR10288591614947360769/creative/CR11567544236161105921?region=FR");
    assert.equal(video?.format, "video");
    assert.equal(video?.preview?.kind, "render");
    assert.equal(video?.first_shown, "2026-02-22");
  });

  it("parses a creative with regional impressions", () => {
    const d = parseCreativeDetail(fixtureJson("creative_text_images_old.json"), "FR", "fr");
    assert.equal(d.format, "text");
    assert.deepEqual(d.topic, { id: 10017, label: "Voyage et tourisme" });
    assert.equal(d.regions[0]?.region_code, "FR");
    assert.deepEqual(d.regions[0]?.impressions, { lower: 300000, upper: 350000 });
    assert.equal(d.regions[0]?.first_shown, "2023-03-01");
    assert.equal(d.regions[0]?.first_shown_clipped, true);
    assert.equal(d.regions.find((r) => r.region_code === "GP")?.first_shown, "2023-03-05");
    assert.equal(d.regions[0]?.impressions_counted_since, "2023-03-01");
    assert.deepEqual(d.regions[0]?.impressions_by_platform[0], { platform: "search", impressions: { lower: 250000, upper: 300000 } });
    const morocco = d.regions.find((r) => r.region_code === "MA");
    assert.equal(morocco?.impressions, null);
    assert.equal(morocco?.last_shown, "2026-09-29");
    const gp = d.regions.find((r) => r.region_code === "GP");
    assert.deepEqual(gp?.impressions, { lower: 0, upper: 1000 });
    assert.equal(d.audience_selection?.contextual_signals, "included_and_excluded");
    assert.equal(d.audience_selection?.topics_of_interest, "unused");
    assert.equal(d.variants.length, 2);
    assert.equal(d.variants[0]?.width, 348);
  });

  it("parses impressions not yet available", () => {
    const d = parseCreativeDetail(fixtureJson("creative_image.json"), "FR", "en");
    assert.equal(d.totals?.impressions, null);
    assert.equal(d.totals?.impressions_available_from, "2026-11-22");
    assert.equal(d.topic?.label, "Travel & Tourism");
    assert.equal(d.audience_selection?.demographics, "included_and_excluded");
  });
});

describe("render scripts", () => {
  it("unescapes JS strings", () => {
    assert.equal(unescapeJs("\\x3cb\\x3e \\x22hi\\x22 \\u00e9 \\\\x3c"), '<b> "hi" é \\x3c');
  });

  it("extracts the text of a search ad", () => {
    const info = parseRenderScript(fixture("render_text.js"));
    assert.deepEqual(info.text, {
      headline: "Retrouvez Toutes Nos Offres",
      display_url: "www.sncf-connect.com/",
      description: "Déplacez vous partout en France et réservez votre billet en ligne à prix promo.",
    });
    assert.equal(info.youtube_video_id, null);
  });

  it("extracts a YouTube video ID", () => {
    assert.equal(parseRenderScript(fixture("render_video.js")).youtube_video_id, "uNqXkzcoYxc");
  });

  it("extracts display assets without duplicates", () => {
    assert.deepEqual(extractAssetImages(unescapeJs(fixture("render_display.js"))), [
      "https://tpc.googlesyndication.com/simgad/5017079113263608808",
      "https://tpc.googlesyndication.com/simgad/6344896548449234518",
    ]);
  });
});

describe("request building and transport", () => {
  const make = (calls: RecordedCall[], opts = {}) =>
    new AtcService(new HttpClient({ fetchImpl: mockFetch(calls, opts), minIntervalMs: 0, concurrency: 2, timeoutMs: 5000, retries: 0 }), new TtlCache(), "fr");

  it("builds SearchCreatives requests like the web app", () => {
    const atc = make([]);
    const req = atc.buildSearchRequest(
      { domain: "sncf-connect.com", region: { code: "FR", id: 2250 }, format: "image", platform: "youtube", dateFrom: "2026-09-01", dateTo: "2026-09-29" },
      40,
    );
    assert.deepEqual(req, {
      "2": 40,
      "3": { "4": 2, "6": 20260901, "7": 20260930, "8": [2250], "12": { "1": "sncf-connect.com", "2": true }, "14": [5] },
      "7": { "1": 1, "2": 0, "3": 2250 },
    });
    const anywhere = atc.buildSearchRequest({ advertiserIds: ["AR05322865601155170305"], region: { code: "anywhere", id: null } }, 100, "CUR");
    assert.deepEqual(anywhere, {
      "2": 100,
      "3": { "12": { "1": "", "2": true }, "13": { "1": ["AR05322865601155170305"] } },
      "4": "CUR",
      "7": { "1": 1 },
    });
  });

  it("paginates with the cursor until the limit", async () => {
    const calls: RecordedCall[] = [];
    const atc = make(calls);
    const res = await atc.listCreatives({ domain: "parcasterix.fr", region: { code: "FR", id: 2250 } }, { limit: 6 });
    assert.equal(res.creatives.length, 6);
    assert.equal(res.pages, 2);
    assert.equal(calls[1]?.request["4"], "CgoAP7zmjUiMjZHjEhAYgwjpBnB5noNOEDwAAAAAGgn8+Gjo+DuQ3LE=");
  });

  it("caches identical requests", async () => {
    const calls: RecordedCall[] = [];
    const atc = make(calls);
    const f = { domain: "parcasterix.fr", region: { code: "FR", id: 2250 } };
    await atc.countCreatives(f);
    await atc.countCreatives(f);
    assert.equal(calls.length, 1);
  });

  it("reports throttling clearly", async () => {
    await assert.rejects(make([], { rpcStatus: 429 }).suggest("sncf"), (e: Error) => e.name === "GatcError" && /429/.test(e.message));
    await assert.rejects(
      make([], { rpcBody: "<html>Our systems have detected unusual traffic</html>" }).suggest("sncf"),
      /CAPTCHA/,
    );
    await assert.rejects(make([], { rpcBody: "{}", rpcUrl: "https://www.google.com/sorry/index?continue=x" }).suggest("x"), /sorry/);
  });
});
