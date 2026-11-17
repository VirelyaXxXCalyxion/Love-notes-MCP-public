import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { Archive, BridgeError, observeStage, type Environment, type Fetcher, type Settings, type StageReporter } from "./core.ts";

export interface Dependencies {
  fetch?: Fetcher;
  getKey?: JWTVerifyGetKey;
  settings?: () => Promise<Settings | null>;
  report?: (requestId: string, event: Parameters<StageReporter>[0]) => void;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

export function createHandler(env: Environment, dependencies: Dependencies = {}) {
  const archive = new Archive(env, dependencies.fetch);
  const getKey = dependencies.getKey ?? createRemoteJWKSet(
    new URL(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`),
    { timeoutDuration: 8_000 },
  );
  const resourceMetadata = `${env.resourceUrl}/oauth-protected-resource`;
  const challenge = `Bearer resource_metadata="${resourceMetadata}", scope="openid"`;

  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    const root = new URL(env.resourceUrl).pathname.replace(/\/$/, "");
    // The hosted Edge gateway removes /functions/v1 before handing us Request.
    // Keep the public URL as the token audience and accept only these two mounts.
    const mounts = [root, `/${root.split("/").filter(Boolean).at(-1)}`];
    if (request.method === "GET" && mounts.some((mount) => path === `${mount}/oauth-protected-resource`)) {
      return json({
        resource: env.resourceUrl, authorization_servers: [`${env.supabaseUrl}/auth/v1`],
        scopes_supported: ["openid"], resource_name: "Love Notes",
      });
    }
    if (request.method === "GET" && mounts.some((mount) => path === `${mount}/health`)) {
      return json({ service: "Love Notes MCP", version: "1.0.0", transport: "streamable-http" });
    }
    if (!mounts.includes(path)) return json({ error: "not_found" }, 404);
    const requestId = crypto.randomUUID();
    const report: StageReporter = (event) => dependencies.report?.(requestId, event);
    const unauthorized = () => json({ error: "authentication_required" }, 401, { "WWW-Authenticate": challenge });
    const authorization = request.headers.get("Authorization");
    if (!authorization?.match(/^Bearer \S+$/i)) {
      report({ stage: "authorization", outcome: "failed", elapsed_ms: 0, code: "bearer_missing" });
      return unauthorized();
    }
    let settings: Settings;
    try {
      settings = await observeStage(report, "bridge_settings", async () => {
        const configured = await (dependencies.settings?.() ?? archive.settings());
        if (!configured?.enabled || !configured.owner_id || !configured.oauth_client_ids.length || configured.resource_url !== env.resourceUrl) {
          throw new BridgeError("owner_connection_not_configured", "The owner connection is not configured.");
        }
        return configured;
      });
    } catch (error) {
      const code = error instanceof BridgeError && error.code === "owner_connection_not_configured"
        ? error.code : "configuration_unavailable";
      return json({ error: code }, 503);
    }
    let owner: string;
    try {
      owner = await observeStage(report, "authorization", async () => {
        const { payload } = await jwtVerify(authorization.slice(7), getKey, {
          issuer: `${env.supabaseUrl}/auth/v1`, audience: env.resourceUrl,
          algorithms: ["ES256", "RS256"], requiredClaims: ["sub", "exp", "iat", "client_id", "scope"],
        }).catch((error: unknown) => {
          if (error instanceof errors.JWKSTimeout) {
            throw new BridgeError("signing_keys_timeout", "The bridge could not reach the signing keys in time.");
          }
          if (error instanceof errors.JWTExpired) {
            throw new BridgeError("token_expired", "The access token has expired.");
          }
          throw new BridgeError("token_rejected", "The token is not authorized for this bridge.");
        });
        if (payload.sub !== settings.owner_id ||
            typeof payload.client_id !== "string" || !settings.oauth_client_ids.includes(payload.client_id) ||
            typeof payload.scope !== "string" || !payload.scope.split(" ").includes("openid")) {
          throw new BridgeError("token_rejected", "The token is not authorized for this bridge.");
        }
        return payload.sub;
      });
    } catch (error) {
      if (error instanceof BridgeError && error.code === "signing_keys_timeout") return json({ error: error.code }, 503);
      return unauthorized();
    }
    const server = new McpServer({ name: "Love Notes", version: "1.0.0" });
    const securitySchemes = [{ type: "oauth2", scopes: ["openid"] }];
    const meta = { securitySchemes };
    const result = async (run: () => Promise<Record<string, unknown>>) => {
      try {
        const value = await run();
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        const failure = error instanceof BridgeError ? error : new BridgeError("unavailable", "The archive operation could not be completed.");
        return {
          isError: true, content: [{ type: "text" as const, text: failure.message }],
          structuredContent: { error: failure.code, retry_same_offering: false },
        };
      }
    };
    server.registerTool("search", {
      title: "Search Love Notes", description: "Search stored voice note titles and paths. Does not generate or change notes.",
      inputSchema: { query: z.string().max(1000) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: meta,
    }, ({ query }) => result(() => observeStage(report, "search", () => archive.search(query))));
    server.registerTool("fetch", {
      title: "Fetch Love Note", description: "Read one existing voice note by its ID or storage path.",
      inputSchema: { id: z.string().min(1).max(1000) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: meta,
    }, ({ id }) => result(() => observeStage(report, "fetch", () => archive.fetch(id))));
    server.registerTool("create_voice_note", {
      title: "Create Voice Note", description: "Generate a voice with ElevenLabs, save it in Love Notes, and verify the saved note. Never automatically retry an uncertain offering.",
      inputSchema: {
        text: z.string().min(1).max(10000), voice_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        title: z.string().max(500).nullable().optional(),
        model_id: z.enum(["eleven_v3", "eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5"]).nullable().optional(),
        idempotency_key: z.string().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, _meta: meta,
    }, (input) => result(() => observeStage(report, "create_voice_note", () => archive.createVoice(input, owner, report))));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const transportStarted = performance.now();
    const response = await transport.handleRequest(request);
    report({
      stage: "mcp_transport", outcome: response.ok ? "completed" : "failed",
      elapsed_ms: Math.round(performance.now() - transportStarted), code: `http_${response.status}`,
    });
    return response;
  };
}
