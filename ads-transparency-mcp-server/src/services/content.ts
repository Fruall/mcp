/**
 * Parser for the ad "render scripts" (displayads-formats.googleusercontent.com/ads/preview/content.js).
 * The script embeds the ad's HTML as an escaped JS string. From it we recover:
 *  - the text of a search ad, when Google exposes it (key "361903925": [.., headline, display URL, description]);
 *  - the YouTube video ID of a video ad (from its ytimg thumbnail);
 *  - the image assets of display / Demand Gen ads.
 */
import type { TextAd } from "../types.js";

export interface RenderInfo {
  text: TextAd | null;
  youtube_video_id: string | null;
  asset_images: string[];
}

const TEXT_AD_KEY = '"361903925":[';

/** Decodes the JS string escapes used by the render script (\xHH, \uHHHH, \n, \', \\). */
export function unescapeJs(source: string): string {
  return source.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|n|r|t|'|"|\/|\\)/g, (_, seq: string) => {
    switch (seq[0]) {
      case "x":
      case "u":
        return String.fromCharCode(Number.parseInt(seq.slice(1), 16));
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return seq;
    }
  });
}

/** Returns the JSON array that starts at `start` (which must point at "["), or null. */
export function sliceJsonArray(text: string, start: number): string | null {
  if (text[start] !== "[") return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[⁦-⁩‎‏]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}

export function extractTextAd(html: string): TextAd | null {
  const at = html.indexOf(TEXT_AD_KEY);
  if (at < 0) return null;
  const json = sliceJsonArray(html, at + TEXT_AD_KEY.length - 1);
  if (!json) return null;
  try {
    const fields = JSON.parse(json) as unknown[];
    const text: TextAd = {
      headline: clean(fields[7]),
      display_url: clean(fields[8]),
      description: clean(fields[9]),
    };
    return text.headline || text.description ? text : null;
  } catch {
    return null;
  }
}

export function extractYoutubeId(html: string): string | null {
  const match = /(?:ytimg\.com\/vi(?:_webp)?\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(html);
  return match?.[1] ?? null;
}

export function extractAssetImages(html: string, limit = 6): string[] {
  const seen = new Set<string>();
  const ids = new Set<string>();
  const re = /https:\/\/tpc\.googlesyndication\.com\/((?:archive\/)?simgad\/(\d+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && seen.size < limit) {
    const id = match[2] as string;
    if (ids.has(id)) continue;
    ids.add(id);
    seen.add(`https://tpc.googlesyndication.com/${match[1]}`);
  }
  return [...seen];
}

export function parseRenderScript(script: string): RenderInfo {
  const html = unescapeJs(script);
  return {
    text: extractTextAd(html),
    youtube_video_id: extractYoutubeId(html),
    asset_images: extractAssetImages(html),
  };
}

export function youtubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
