import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture(name: string): string {
  return readFileSync(path.join(dir, name), "utf8");
}

export function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(fixture(name)) as Record<string, unknown>;
}

// 1×1 transparent PNG.
export const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

export interface RecordedCall {
  service: string;
  request: Record<string, unknown>;
}

export interface MockOptions {
  /** Force every RPC to answer with this status / body. */
  rpcStatus?: number;
  rpcBody?: string;
  rpcUrl?: string;
}

/** A fetch replacement that answers from the captured fixtures and records RPC requests. */
export function mockFetch(calls: RecordedCall[], options: MockOptions = {}) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/anji/_/rpc/")) {
      const service = url.split("/rpc/")[1]?.split("?")[0] ?? "";
      const body = decodeURIComponent(String(init?.body ?? "").replace(/^f\.req=/, ""));
      const request = JSON.parse(body) as Record<string, unknown>;
      calls.push({ service, request });
      if (options.rpcStatus || options.rpcBody) {
        const res = new Response(options.rpcBody ?? "", {
          status: options.rpcStatus ?? 200,
          headers: { "content-type": options.rpcBody?.startsWith("<") ? "text/html" : "application/json" },
        });
        if (options.rpcUrl) Object.defineProperty(res, "url", { value: options.rpcUrl });
        return res;
      }
      const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
      switch (service) {
        case "SearchService/SearchSuggestions":
          return json(fixtureJson("suggestions_sncf.json"));
        case "LookupService/GetAdvertiserById":
          // Unknown advertisers get an empty body, as observed live.
          if (request["1"] !== "AR10288591614947360769") return new Response("", { headers: { "content-type": "application/binary" } });
          return json(fixtureJson("advertiser_carat.json"));
        case "LookupService/GetCreativeById": {
          const byId: Record<string, string> = {
            CR01344536737463926785: "creative_text_render.json",
            CR10209869331177668609: "creative_text_images_old.json",
            CR16250029663726862337: "creative_video.json",
            CR15749406145401323521: "creative_image.json",
          };
          const file = byId[String(request["2"])];
          return json(file ? fixtureJson(file) : {});
        }
        case "SearchService/SearchCreatives": {
          if (request["4"]) return json(fixtureJson("search_page2.json"));
          const page = fixtureJson("search_parcasterix_fr.json");
          const size = Number(request["2"]);
          const list = (page["1"] as unknown[]).slice(0, size);
          return json({ ...page, "1": list });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    }
    if (url.includes("/ads/preview/content.js")) {
      if (url.includes("creativeId=815349419242")) return new Response(fixture("render_text.js"));
      if (url.includes("creativeId=794069263406")) return new Response(fixture("render_video.js"));
      return new Response(fixture("render_display.js"));
    }
    if (url.startsWith("https://tpc.googlesyndication.com/") || url.startsWith("https://i.ytimg.com/")) {
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }
    return new Response("unexpected url", { status: 500 });
  };
}
