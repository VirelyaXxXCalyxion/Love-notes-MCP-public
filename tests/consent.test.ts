import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const browserScript = readFileSync(new URL("../web/oauth/consent/consent.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/, "");

function page(scope: string) {
  const handlers = new Map<string, () => Promise<void>>();
  const elements = new Map<string, {
    hidden: boolean; textContent: string; value: string; disabled: boolean;
    addEventListener(type: string, handler: (event: { preventDefault(): void }) => Promise<void>): void;
  }>();
  for (const id of ["status", "login", "consent", "approve", "deny", "email", "password", "client-name", "scopes", "return-address"]) {
    elements.set(id, {
      hidden: true, textContent: "", value: id === "password" ? "test-only-password" : "owner@example.test", disabled: false,
      addEventListener(type, handler) { handlers.set(`${id}:${type}`, () => handler({ preventDefault() {} })); },
    });
  }
  let approvalCalls = 0;
  runInNewContext(browserScript, {
    URL, Set, Map,
    location: { href: "https://consent.example/oauth/consent?authorization_id=test-request", replace() {} },
    document: {
      getElementById: (id: string) => elements.get(id),
      querySelectorAll: () => [],
    },
    createClient: () => ({
      auth: {
        signInWithPassword: async () => ({ error: null }),
        oauth: { getAuthorizationDetails: async () => ({
          data: { authorization_id: "test-request", scope, client: { id: "test-client", name: "ChatGPT" }, redirect_uri: "https://chatgpt.com/connector/oauth/test" },
          error: null,
        }) },
      },
      rpc: async () => { approvalCalls++; return { error: null }; },
    }),
  });
  return { elements, handlers, get approvalCalls() { return approvalCalls; } };
}

test("the live ChatGPT scope request reaches consent and discloses email and refresh access", async () => {
  const p = page("openid email offline_access");
  await p.handlers.get("login:submit")!();
  assert.equal(p.elements.get("consent")!.hidden, false);
  assert.equal(p.elements.get("login")!.hidden, true);
  assert.match(p.elements.get("scopes")!.textContent, /owner account email address \(email\)/);
  assert.match(p.elements.get("scopes")!.textContent, /refresh tokens \(offline_access\)/);
  assert.equal(p.approvalCalls, 0, "signing in must not approve the connection");
});

test("identity-only requests still work and scope whitespace is normalized", async () => {
  for (const scope of ["openid", " email\topenid  offline_access "]) {
    const p = page(scope);
    await p.handlers.get("login:submit")!();
    assert.equal(p.elements.get("consent")!.hidden, false);
  }
});

test("unsupported or identity-free requests cannot reach owner approval", async () => {
  for (const scope of ["openid email profile", "openid phone", "openid notes:delete", "email offline_access", ""]) {
    const p = page(scope);
    await p.handlers.get("login:submit")!();
    assert.equal(p.elements.get("consent")!.hidden, true);
    assert.match(p.elements.get("status")!.textContent, /permissions Love Notes does not support/);
    await p.handlers.get("approve:click")!();
    assert.equal(p.approvalCalls, 0);
  }
});
