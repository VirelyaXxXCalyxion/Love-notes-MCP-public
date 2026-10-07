import { createHandler } from "./app.ts";

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resourceUrl = `${supabaseUrl}/functions/v1/love-notes-mcp`;
const handle = createHandler({
  supabaseUrl, serviceRoleKey, resourceUrl,
  elevenLabsKey: Deno.env.get("ELEVENLABS_API_KEY"),
  bucket: Deno.env.get("LOVE_NOTES_BUCKET") || "love-notes",
});

Deno.serve(async (request) => {
  try {
    return await handle(request);
  } catch {
    // Avoid logging words, API keys, access tokens, or provider error bodies.
    return new Response(JSON.stringify({ error: "bridge_unavailable" }), {
      status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
});
