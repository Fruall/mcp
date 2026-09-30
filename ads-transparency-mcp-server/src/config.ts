import os from "node:os";
import path from "node:path";
import type { Lang } from "./i18n.js";

export interface Config {
  transport: "stdio" | "http";
  port: number;
  host: string;
  authToken: string | null;
  defaultRegion: string;
  lang: Lang;
  /** Minimum delay between two calls to adstransparency.google.com, in ms. */
  minIntervalMs: number;
  concurrency: number;
  timeoutMs: number;
  exportDir: string;
  /** Public base URL of this server (HTTP mode) used to build export download links. */
  publicBaseUrl: string | null;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): Config {
  const transportArg = argv.includes("--http") ? "http" : argv.includes("--stdio") ? "stdio" : undefined;
  const transport = (transportArg ?? env.TRANSPORT ?? "stdio").toLowerCase() === "http" ? "http" : "stdio";
  const lang = (env.GATC_LANG ?? "fr").toLowerCase() === "en" ? "en" : "fr";
  return {
    transport,
    port: int(env.PORT, 3000),
    host: env.HOST ?? "127.0.0.1",
    authToken: env.MCP_AUTH_TOKEN?.trim() || null,
    defaultRegion: (env.GATC_DEFAULT_REGION ?? "FR").toUpperCase(),
    lang,
    minIntervalMs: int(env.GATC_MIN_INTERVAL_MS, 300),
    concurrency: Math.max(1, int(env.GATC_CONCURRENCY, 2)),
    timeoutMs: Math.max(1_000, int(env.GATC_TIMEOUT_MS, 20_000)),
    exportDir: path.resolve(env.GATC_EXPORT_DIR ?? path.join(os.homedir(), "gatc-exports")),
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || null,
  };
}
