import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { Archive, BridgeError, type Environment, type Fetcher, type Settings } from "./core.ts";

export interface Dependencies {
  fetch?: Fetcher;
  getKey?: JWTVerifyGetKey;
  settings?: () => Promise<Settings | null>;
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
    const unauthorized = () => json({ error: "authentication_required" }, 401, { "WWW-Authenticate": challenge });
    const authorization = request.headers.get("Authorization");
    if (!authorization?.match(/^Bearer \S+$/i)) return unauthorized();
    let settings: Settings | null;
    try {
      settings = await (dependencies.settings?.() ?? archive.settings());
    } catch {
      return json({ error: "configuration_unavailable" }, 503);
    }
    if (!settings?.enabled || !settings.owner_id || !settings.oauth_client_ids.length || settings.resource_url !== env.resourceUrl) {
      return json({ error: "owner_connection_not_configured" }, 503);
    }
    let owner: string;
    try {
      const { payload } = await jwtVerify(authorization.slice(7), getKey, {
        issuer: `${env.supabaseUrl}/auth/v1`, audience: env.resourceUrl,
        algorithms: ["ES256", "RS256"], requiredClaims: ["sub", "exp", "iat", "client_id", "scope"],
      });
      if (payload.sub !== settings.owner_id ||
          typeof payload.client_id !== "string" || !settings.oauth_client_ids.includes(payload.client_id) ||
          typeof payload.scope !== "string" || !payload.scope.split(" ").includes("openid")) {
        return unauthorized();
      }
      owner = payload.sub;
    } catch {
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
    }, ({ query }) => result(() => archive.search(query)));
    server.registerTool("fetch", {
      title: "Fetch Love Note", description: "Read one existing voice note by its ID or storage path.",
      inputSchema: { id: z.string().min(1).max(1000) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: meta,
    }, ({ id }) => result(() => archive.fetch(id)));
    server.registerTool("create_voice_note", {
      title: "Create Voice Note", description: "Generate a voice with ElevenLabs, save it in Love Notes, and verify the saved note. Never automatically retry an uncertain offering.",
      inputSchema: {
        text: z.string().min(1).max(10000), voice_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        title: z.string().max(500).nullable().optional(),
        model_id: z.enum(["eleven_v3", "eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5"]).nullable().optional(),
        idempotency_key: z.string().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, _meta: meta,
    }, (input) => result(() => archive.createVoice(input, owner)));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return await transport.handleRequest(request);
  };
}
