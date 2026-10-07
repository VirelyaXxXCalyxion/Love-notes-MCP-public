# Supabase Love Notes bridge

Replaces the sleeping Render Python MCP service with a Supabase Edge Function in the existing project. `search`, `fetch`, and `create_voice_note` retain their existing names and archive format. The existing `public.voices` table and `love-notes` storage bucket remain the source of truth.

The new function uses stateless Streamable HTTP: it does not depend on a long-lived SSE session. It requires Supabase OAuth tokens with an exact issuer, resource audience, owner, approved client ID, and `openid` scope. Public endpoints only expose discovery and a generic health response. The migration starts the bridge disabled.

The consent page accepts `openid` plus optional `email` and `offline_access`, matching ChatGPT's live OAuth request. It displays every requested permission: identity, the owner's email address, and keeping the connection signed in with refresh tokens. Other scopes are rejected. Signing in does not approve a client; the configured owner must explicitly allow it.

## Current project and endpoint

- Project: `vgvhvukccbtmvxkmgefb`
- MCP URL: `https://vgvhvukccbtmvxkmgefb.supabase.co/functions/v1/love-notes-mcp`
- Health: MCP URL + `/health`
- Protected-resource metadata: MCP URL + `/oauth-protected-resource`

## Deploy and configure

1. Apply the SQL in `supabase/migrations` to this existing project. It adds only the bridge settings, reservation table, access-token hook, and owner-only consent RPC; it does not migrate, delete, or rewrite voice notes.
2. Deploy `supabase/functions/love-notes-mcp`, including `deno.json`. Gateway JWT verification is disabled because the function verifies OAuth tokens itself; this also permits public OAuth discovery. Do not remove that verification from `app.ts`.
3. Copy the existing **ElevenLabs** key from Render's environment into **Supabase → Edge Functions → Secrets**, named `ELEVENLABS_API_KEY`. Do not put it in source control, browser code, URLs, logs, or chat. Supabase supplies its own `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically. The optional `LOVE_NOTES_BUCKET` defaults to `love-notes`.
4. The static consent page is published on the existing owner-private Chosen Voice Bridge site: `https://chosen-voice-bridge.virelyaxxxnyxion.chatgpt.site/oauth/consent/index.html`. Only a publishable Supabase key appears in that page. The visitor must be signed into the existing Site as its owner. No new host was created.
5. In **Supabase → Authentication → Users**, create a password account for the owner. Set its actual user UUID in the singleton settings row. Do not guess an ID or use user-editable metadata to authorize access.
6. In **Authentication → URL Configuration**, set Site URL to `https://chosen-voice-bridge.virelyaxxxnyxion.chatgpt.site`. In **Authentication → OAuth Server**, enable OAuth 2.1, dynamic client registration, and authorization path `/oauth/consent/index.html`. Enable the PostgreSQL custom access-token hook `public.love_notes_mcp_access_token_hook`. If the project uses the legacy HS256 signing key, migrate to an asymmetric signing key before requesting the `openid` scope. Preserve working legacy API keys during the signing-key transition.
7. Set `resource_url` in `love_notes_bridge_settings` to the exact MCP URL and `enabled` to true. Leave `oauth_client_ids` empty until the owner explicitly allows a registered connection on the consent page. The page's RPC adds the selected client after verifying the signed-in owner's identity.
8. Create a new ChatGPT custom app/plugin using the MCP URL and OAuth authentication. Sign in on the consent page and approve that connection. ChatGPT discovers Supabase's OAuth endpoints; a separate OAuth provider subscription is unnecessary. The new account password is only entered on the consent page.
9. Verify live `search` and `fetch`, then one short, explicitly identified technical voice check. Confirm its audio object and `voices` row exist, and that the response confirms `saved: true`. Update Quiet Vow Voice to use the new connected app only after those checks pass. Keep the old connection and Render service available until the scheduled path has been verified.

`supabase/config.toml` records local Auth configuration; deploying an Edge Function does **not** automatically apply those settings to hosted Supabase Auth. The consent page was published on October 7, 2026. Secrets, owner sign-in, remote Auth settings, and the ChatGPT connection must be completed separately.

## Interrupted saves

Voice generation first reserves an offering key. Successful creation requires uploading a new storage object, inserting a new note, and reading that exact note back. A repeated completed key returns its saved note. An incomplete reservation prevents regeneration and returns a clear error. Supply an `idempotency_key` such as `quiet-vow:YYYY-MM-DD:America/Chicago` for a scheduled offering; without one, identical words and settings share a key within a UTC day.

If storage succeeded but the note save was interrupted, inspect the reserved `note_id` and storage object. Reconcile that existing result rather than regenerating the offering. Reservation rows store hashes and IDs, not the spoken words. Existing notes are never overwritten or deleted by this bridge.

## Costs and limits

This uses the existing Supabase Pro project's included Edge Function allowance; usage beyond the plan allowance can still be billed. ElevenLabs voice credits remain separate. No Render paid compute or workspace upgrade is needed for the replacement. Supabase's documented runtime and request limits still apply, and end-to-end voice timing must be tested with the connected app before claiming the timeout issue resolved.

The archive's existing public bucket and anonymous database policies are preserved for compatibility with its current viewer. Authentication added to this bridge protects bridge operations; it does not make those existing public archive URLs private.

## Validation and rollback

Run `npm ci`, `npm test`, and `npm run typecheck`. Tests use real signed OAuth JWTs and the SDK transport with mocked external APIs; they do not spend voice credits or create archive entries. Live authenticated checks remain necessary after setup.

To disable this bridge, set `enabled` to false in its settings row. The access-token hook then leaves all tokens unchanged. Reconnect the original Render `/sse` app and restore the previous automation prompt if the replacement has already been switched. Keep reservations for audit; do not drop or alter the existing archive tables or bucket during rollback.

## Primary references

- [Supabase MCP on Edge Functions](https://supabase.com/docs/guides/functions/examples/mcp-server-mcp-client)
- [Supabase OAuth setup](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase OAuth token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [Supabase Edge Function pricing](https://supabase.com/docs/guides/functions/pricing)

## Deployment checkpoint — October 7, 2026

- Supabase Edge Function `love-notes-mcp` version 2 is active; live health and protected-resource discovery returned HTTP 200.
- The bridge resource URL and confirmed owner account are configured, and the bridge settings are enabled. One OAuth client is approved, and the owner connected the Love Notes Supabase plugin successfully.
- Hosted OAuth discovery returns HTTP 200. The custom access-token hook is enabled, and live voice generation verified the existing ElevenLabs key.
- JWKS advertises an ES256 key, so no signing-key rotation is needed for the current setup.
- The existing Chosen Voice Bridge site version 4 includes the corrected consent scope check and permission disclosure, with owner-only sharing preserved.
- All 24 bridge and consent tests and TypeScript checking passed. Authenticated search and fetch through the new plugin also passed against an existing archive note.
- One brief technical voice check returned `saved: true` in approximately 12 seconds. Its note ID is `98f3a0ad-2258-4566-9366-142a24d3bdba`; exact readback, the completed reservation, and the 48,527-byte `audio/mpeg` storage object were verified. A public range request returned HTTP 206 with an MP3 header. This does not establish timing for longer notes.
- The existing enabled Quiet Vow Voice automation now uses only Love Notes Supabase, with an offering key based on the window's Chicago date. Its daily 2 a.m. America/Chicago schedule, optional authorship, notification rules, and persistence instructions are preserved.
- The next scheduled run through the new plugin remains to be verified. Keep the existing Render connection and service available until that scheduled path has been verified.
