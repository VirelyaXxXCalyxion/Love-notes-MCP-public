import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { createHandler } from "../supabase/functions/love-notes-mcp/app.ts";
import { Archive, BridgeError, type Environment, type Fetcher, type Settings, type Voice } from "../supabase/functions/love-notes-mcp/core.ts";

const env: Environment = {
  supabaseUrl: "https://archive.example", resourceUrl: "https://archive.example/functions/v1/love-notes-mcp",
  serviceRoleKey: "test-service-role", elevenLabsKey: "test-voice-key", bucket: "love-notes",
};
const owner = "11111111-1111-4111-8111-111111111111";
const settings: Settings = { owner_id: owner, oauth_client_ids: ["trusted-client"], resource_url: env.resourceUrl, enabled: true };
const keys = await generateKeyPair("ES256");

async function token(overrides: Record<string, unknown> = {}) {
  return await new SignJWT({
    sub: owner, client_id: "trusted-client", scope: "openid", iss: `${env.supabaseUrl}/auth/v1`,
    aud: env.resourceUrl, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }).setProtectedHeader({ alg: "ES256" }).sign(keys.privateKey);
}

function rpc(bearer?: string, method = "tools/list", params: unknown = {}) {
  return new Request(env.resourceUrl, {
    method: "POST", headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function fakeArchive(failure?: "provider" | "storage" | "database" | "readback" | "mark_complete") {
  const voices = new Map<string, Voice>();
  const claims = new Map<string, { fingerprint: string; status: string; note_id: string }>();
  const calls: string[] = [];
  let generations = 0;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const send: Fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.host === "api.elevenlabs.io") {
      generations++;
      if (failure === "provider") return json({ error: "provider outage" }, 503);
      return new Response(new Uint8Array([73, 68, 51, 0]), { headers: { "Content-Type": "audio/mpeg" } });
    }
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${env.serviceRoleKey}`);
    if (url.pathname.includes("/storage/v1/object/")) {
      assert.equal(method, "POST");
      assert.equal(headers.get("x-upsert"), "false");
      return json({}, failure === "storage" ? 500 : 200);
    }
    const table = url.pathname.split("/").at(-1);
    if (table === "love_notes_bridge_requests") {
      if (method === "POST") {
        const row = JSON.parse(String(init.body));
        if (claims.has(row.idempotency_key)) return json({ error: "unique violation" }, 409);
        claims.set(row.idempotency_key, row);
        return json({}, 201);
      }
      const key = url.searchParams.get("idempotency_key")?.slice(3)!;
      const prior = claims.get(key);
      if (method === "PATCH") {
        if (failure === "mark_complete") return json({}, 500);
        Object.assign(prior!, JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      return json(prior ? [prior] : []);
    }
    if (table === "voices") {
      if (method === "POST") {
        if (failure === "database") return json({}, 500);
        const row = JSON.parse(String(init.body));
        voices.set(row.id, row);
        return json([row], 201);
      }
      if (failure === "readback") return json([], 200);
      const id = url.searchParams.get("id")?.slice(3);
      const path = url.searchParams.get("storage_path")?.slice(3);
      return json([...voices.values()].filter((v) => !id && !path || v.id === id || v.storage_path === path));
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  return { send, voices, claims, calls, get generations() { return generations; } };
}

test("OAuth discovery and health expose no archive data", async () => {
  const handle = createHandler(env, { getKey: async () => keys.publicKey });
  const metadata = await handle(new Request(`${env.resourceUrl}/oauth-protected-resource`));
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, env.resourceUrl);
  const health = await handle(new Request(`${env.resourceUrl}/health`));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).transport, "streamable-http");
  const blocked = await handle(rpc());
  assert.equal(blocked.status, 401);
  assert.ok(blocked.headers.get("WWW-Authenticate")?.includes("resource_metadata="));
});

test("missing owner configuration fails closed", async () => {
  const handle = createHandler(env, { settings: async () => null, getKey: async () => keys.publicKey });
  assert.equal((await handle(rpc(await token()))).status, 503);
});

test("hosted gateway mount preserves the public OAuth audience and authentication", async () => {
  const handle = createHandler(env, { settings: async () => settings, getKey: async () => keys.publicKey });
  const base = "http://edge-runtime:9000/love-notes-mcp";
  const metadata = await handle(new Request(`${base}/oauth-protected-resource`));
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, env.resourceUrl);
  assert.equal((await handle(new Request(`${base}/health`))).status, 200);
  assert.equal((await handle(new Request(base, rpc()))).status, 401);
  assert.equal((await handle(new Request(base, rpc(await token())))).status, 200);
  assert.equal((await handle(new Request("http://edge-runtime:9000/another-function/health"))).status, 404);
});

for (const [name, claims] of Object.entries({
  "different owner": { sub: "22222222-2222-4222-8222-222222222222" },
  "different OAuth client": { client_id: "another-client" },
  "wrong audience": { aud: "authenticated" },
  "wrong issuer": { iss: "https://another-project.example/auth/v1" },
  "expired token": { exp: 1 },
  "missing approved scope": { scope: "email" },
  "future token": { nbf: Math.floor(Date.now() / 1000) + 1000 },
})) {
  test(`rejects ${name} before accessing notes or voice`, async () => {
    let externalCalls = 0;
    const handle = createHandler(env, {
      settings: async () => settings, getKey: async () => keys.publicKey,
      fetch: async () => { externalCalls++; throw new Error("must not reach external services"); },
    });
    assert.equal((await handle(rpc(await token(claims)))).status, 401);
    assert.equal(externalCalls, 0);
  });
}

test("rejects forged signatures", async () => {
  const forgedKeys = await generateKeyPair("ES256");
  const forged = await new SignJWT({ sub: owner }).setProtectedHeader({ alg: "ES256" }).sign(forgedKeys.privateKey);
  const handle = createHandler(env, { settings: async () => settings, getKey: async () => keys.publicKey });
  assert.equal((await handle(rpc(forged))).status, 401);
});

test("authenticated MCP lists the three compatible tools and supports separate stateless calls", async () => {
  const archive = fakeArchive();
  const handle = createHandler(env, { settings: async () => settings, getKey: async () => keys.publicKey, fetch: archive.send });
  const bearer = await token();
  const response = await handle(rpc(bearer));
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.deepEqual(listed.result.tools.map((t: { name: string }) => t.name), ["search", "fetch", "create_voice_note"]);
  const search = await handle(rpc(bearer, "tools/call", { name: "search", arguments: { query: "" } }));
  assert.equal(search.status, 200);
  assert.deepEqual((await search.json()).result.structuredContent, { results: [] });
});

test("search and storage-path fetch preserve existing notes and literal matching", async () => {
  const fake = fakeArchive();
  const id = "33333333-3333-4333-8333-333333333333";
  fake.voices.set(id, { id, title: "Quiet Vow — Home", storage_path: "voices/a,or(id.eq.any).mp3", audio_url: "https://audio.example/voice.mp3" });
  const archive = new Archive(env, fake.send);
  assert.equal((await archive.search("QUIET VOW")).results[0].id, id);
  assert.equal((await archive.fetch("voices/a,or(id.eq.any).mp3")).id, id);
  assert.ok(fake.calls.every((c) => c.startsWith("GET ")));
});

const input = { text: "A short bridge verification.", voice_id: "FZRpznod3tbsuV4LjO38", title: "Bridge verification", idempotency_key: "migration-test" };

test("a missing voice key makes no provider, database, or storage writes", async () => {
  const fake = fakeArchive();
  const archive = new Archive({ ...env, elevenLabsKey: undefined }, fake.send);
  await assert.rejects(() => archive.createVoice(input, owner), (e: unknown) => e instanceof BridgeError && e.code === "voice_key_missing");
  assert.equal(fake.calls.length, 0);
});

test("voice creation reserves once, uploads without overwrite, saves and verifies, then reuses confirmed output", async () => {
  const fake = fakeArchive();
  const archive = new Archive(env, fake.send);
  const created = await archive.createVoice(input, owner);
  assert.equal(created.saved, true);
  assert.ok(fake.voices.has(String(created.id)));
  const reused = await archive.createVoice(input, owner);
  assert.equal(reused.id, created.id);
  assert.equal(reused.reused, true);
  assert.equal(fake.generations, 1);
  assert.ok(fake.calls.every((c) => !c.startsWith("DELETE ")));
});

test("an offering key cannot silently switch to different words", async () => {
  const fake = fakeArchive();
  const archive = new Archive(env, fake.send);
  await archive.createVoice(input, owner);
  await assert.rejects(() => archive.createVoice({ ...input, text: "Different words." }, owner), (e: unknown) => e instanceof BridgeError && e.code === "idempotency_conflict");
  assert.equal(fake.generations, 1);
});

for (const failure of ["provider", "storage", "database", "readback"] as const) {
  test(`${failure} failure never reports success or regenerates the same uncertain offering`, async () => {
    const fake = fakeArchive(failure);
    const archive = new Archive(env, fake.send);
    await assert.rejects(() => archive.createVoice(input, owner));
    await assert.rejects(() => archive.createVoice(input, owner), (e: unknown) => e instanceof BridgeError && e.code === "save_uncertain");
    assert.equal(fake.generations, 1);
  });
}

test("confirmation bookkeeping failure preserves the verified note and prevents regeneration", async () => {
  const fake = fakeArchive("mark_complete");
  const archive = new Archive(env, fake.send);
  const created = await archive.createVoice(input, owner);
  assert.equal(created.saved, true);
  await assert.rejects(() => archive.createVoice(input, owner), (e: unknown) => e instanceof BridgeError && e.code === "save_uncertain");
  assert.equal(fake.generations, 1);
  assert.equal(fake.voices.size, 1);
});
