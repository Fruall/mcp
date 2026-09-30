export const SERVER_NAME = "ads-transparency-mcp-server";
export const SERVER_VERSION = "1.0.0";

export const ATC_ORIGIN = "https://adstransparency.google.com";
export const ATC_RPC_BASE = `${ATC_ORIGIN}/anji/_/rpc`;

/** Maximum characters of text returned by a tool before truncation. */
export const CHARACTER_LIMIT = 25_000;

/** Largest page the SearchCreatives RPC accepts (verified: 100 works, 200 returns nothing). */
export const MAX_PAGE_SIZE = 100;

/** Hard ceiling on creatives a single list call may scan through pagination. */
export const MAX_SCAN = 2_000;

/** Hard ceiling on rows an export may contain. */
export const MAX_EXPORT_ROWS = 5_000;

/** Names of export files, the only files the HTTP transport serves. */
export const EXPORT_NAME_RE = /^gatc_[a-z0-9_-]+\.(csv|json)$/;

/** Largest single image returned inline to the model. */
export const MAX_INLINE_IMAGE_BYTES = 900_000;

/** Largest number of images a single tool call returns inline. */
export const MAX_INLINE_IMAGES = 12;

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Creative formats as encoded by the RPC (SearchCreatives field 3.4, creative field 4 / 8). */
export const FORMAT_CODES = { text: 1, image: 2, video: 3 } as const;
export type CreativeFormat = keyof typeof FORMAT_CODES;
export const FORMAT_BY_CODE: Record<number, CreativeFormat> = { 1: "text", 2: "image", 3: "video" };

/** Surfaces as encoded by the RPC (SearchCreatives field 3.14, per-platform stats field 8.1). */
export const PLATFORM_CODES = { play: 1, maps: 2, search: 3, shopping: 4, youtube: 5 } as const;
export type Platform = keyof typeof PLATFORM_CODES;
export const PLATFORM_BY_CODE: Record<number, Platform> = {
  1: "play",
  2: "maps",
  3: "search",
  4: "shopping",
  5: "youtube",
};

/** Audience-selection categories (creative field 13.4.<key>), verified against the UI labels. */
export const AUDIENCE_KEYS: Record<string, string> = {
  "1": "demographics",
  "2": "geo_locations",
  "3": "contextual_signals",
  "4": "topics_of_interest",
  "5": "customer_lists",
};

export const AUDIENCE_CATEGORIES = [
  "demographics",
  "geo_locations",
  "contextual_signals",
  "topics_of_interest",
  "customer_lists",
] as const;
export type AudienceCategory = (typeof AUDIENCE_CATEGORIES)[number];
