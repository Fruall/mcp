#!/usr/bin/env node
/**
 * ads-transparency-mcp-server — MCP server for the Google Ads Transparency Center.
 *
 *   node dist/index.js            # stdio (Claude Desktop, Claude Code)
 *   node dist/index.js --http     # Streamable HTTP on $HOST:$PORT/mcp
 */
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { EXPORT_NAME_RE, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { loadConfig, type Config } from "./config.js";
import { createDeps, createServer, type ServerDeps } from "./server.js";

async function runStdio(deps: ServerDeps): Promise<void> {
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio (region ${deps.config.defaultRegion})`);
}

function bearerGuard(config: Config) {
  const expected = config.authToken ? Buffer.from(config.authToken) : null;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected) return next();
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };
}

async function runHttp(deps: ServerDeps): Promise<void> {
  const { config } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
  });

  if (config.publicBaseUrl) {
    // Export files have unguessable names (random suffix); nothing else is served.
    app.get("/exports/:name", (req, res) => {
      const name = req.params.name;
      if (!EXPORT_NAME_RE.test(name)) {
        res.status(404).end();
        return;
      }
      res.sendFile(path.join(config.exportDir, name), (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    });
  }

  const guard = bearerGuard(config);
  app.post("/mcp", guard, async (req, res) => {
    // Stateless: one server + transport per request, sharing the same cache and rate limiter.
    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null });
  };
  app.get("/mcp", guard, methodNotAllowed);
  app.delete("/mcp", guard, methodNotAllowed);

  app.listen(config.port, config.host, () => {
    console.error(
      `${SERVER_NAME} ${SERVER_VERSION} listening on http://${config.host}:${config.port}/mcp` +
        (config.authToken ? " (bearer token required)" : " (no auth: keep it on localhost or set MCP_AUTH_TOKEN)"),
    );
  });
}

const config = loadConfig();
const deps = createDeps(config);
const run = config.transport === "http" ? runHttp : runStdio;
run(deps).catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
