export type Fetcher = typeof fetch;

export interface Environment {
  supabaseUrl: string;
  serviceRoleKey: string;
  elevenLabsKey?: string;
  bucket: string;
  resourceUrl: string;
}

export interface Settings {
  owner_id: string | null;
  oauth_client_ids: string[];
  resource_url: string;
  enabled: boolean;
}

export interface Voice {
  id: string;
  title: string | null;
  audio_url: string | null;
  storage_path: string | null;
  created_at?: string;
}

export interface VoiceInput {
  text: string;
  voice_id: string;
  title?: string | null;
  model_id?: string | null;
  idempotency_key?: string;
}

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, "0")).join("");
}

export class Archive {
  constructor(
    private readonly env: Environment,
    private readonly send: Fetcher = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("apikey", this.env.serviceRoleKey);
    headers.set("Authorization", `Bearer ${this.env.serviceRoleKey}`);
    if (typeof init.body === "string") headers.set("Content-Type", "application/json");
    return await this.send(`${this.env.supabaseUrl}${path}`, {
      ...init, headers, signal: AbortSignal.timeout(12_000),
    });
  }

  private async rows<T>(table: string, params: URLSearchParams): Promise<T[]> {
    const response = await this.request(`/rest/v1/${table}?${params}`);
    if (!response.ok) throw new BridgeError("archive_unavailable", "The archive could not be read.");
    return await response.json() as T[];
  }

  async settings(): Promise<Settings | null> {
    const rows = await this.rows<Settings>("love_notes_bridge_settings", new URLSearchParams({
      select: "owner_id,oauth_client_ids,resource_url,enabled", id: "eq.true", limit: "1",
    }));
    return rows[0] ?? null;
  }

  async search(query: string): Promise<{ results: Record<string, string>[] }> {
    const q = query.trim().toLowerCase();
    if (!q) return { results: [] };
    // Keep the existing connector's latest-100 and literal substring behavior.
    const voices = await this.rows<Voice>("voices", new URLSearchParams({
      select: "id,title,audio_url,storage_path,created_at", order: "created_at.desc", limit: "100",
    }));
    return { results: voices.filter((v) =>
      `${v.title ?? ""} ${v.audio_url ?? ""} ${v.storage_path ?? ""}`.toLowerCase().includes(q)
    ).map((v) => ({
      id: v.id, title: v.title || v.storage_path || "Voice note",
      text: v.audio_url || "", url: v.audio_url || "",
    })) };
  }

  async fetch(id: string): Promise<Record<string, unknown>> {
    const lookup = id.trim();
    if (!lookup) throw new BridgeError("invalid_id", "A note ID is required.");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lookup);
    const rows = await this.rows<Voice>("voices", new URLSearchParams({
      select: "id,title,audio_url,storage_path,created_at",
      [uuid ? "id" : "storage_path"]: `eq.${lookup}`, limit: "1",
    }));
    const voice = rows[0];
    if (!voice) throw new BridgeError("not_found", "The voice note was not found.");
    return {
      id: voice.id, title: voice.title || "Voice note", text: voice.audio_url || "",
      url: voice.audio_url || "", metadata: {
        storage_path: voice.storage_path, created_at: voice.created_at,
      },
    };
  }

  async createVoice(input: VoiceInput, owner: string): Promise<Record<string, unknown>> {
    if (!this.env.elevenLabsKey) {
      throw new BridgeError("voice_key_missing", "The ElevenLabs key must be configured in Supabase before voice generation.");
    }
    const model = input.model_id || "eleven_v3";
    const title = input.title ?? null;
    const fingerprint = await digest(JSON.stringify([input.text, input.voice_id, title, model]));
    // With no explicit key, identical offerings in the same UTC day share a claim.
    const key = await digest(`${owner}\n${input.idempotency_key ?? `${this.now().toISOString().slice(0, 10)}:${fingerprint}`}`);
    const noteId = crypto.randomUUID();
    const claim = await this.request("/rest/v1/love_notes_bridge_requests", {
      method: "POST", body: JSON.stringify({
        idempotency_key: key, fingerprint, owner_id: owner, note_id: noteId, status: "pending",
      }),
    });
    if (claim.status === 409) {
      const prior = (await this.rows<{ fingerprint: string; status: string; note_id: string }>(
        "love_notes_bridge_requests", new URLSearchParams({
          select: "fingerprint,status,note_id", idempotency_key: `eq.${key}`, limit: "1",
        }),
      ))[0];
      if (!prior || prior.fingerprint !== fingerprint) {
        throw new BridgeError("idempotency_conflict", "This offering key was already used for different words or settings.");
      }
      if (prior.status !== "completed") {
        // A previous attempt may have generated audio or saved a note before losing its response.
        throw new BridgeError("save_uncertain", "This offering already has an incomplete or uncertain attempt. Do not regenerate it; inspect the archive first.");
      }
      const voice = await this.fetch(prior.note_id);
      return {
        id: voice.id, audio_url: voice.url,
        storage_path: (voice.metadata as Record<string, unknown>).storage_path,
        saved: true, reused: true,
      };
    }
    if (!claim.ok) throw new BridgeError("claim_failed", "The offering could not be reserved. No audio was requested.");

    try {
      const audioResponse = await this.send(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voice_id)}`,
        {
          method: "POST",
          headers: { "xi-api-key": this.env.elevenLabsKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text: input.text, model_id: model }),
          signal: AbortSignal.timeout(65_000),
        },
      );
      if (!audioResponse.ok) throw new BridgeError("voice_generation_failed", `ElevenLabs could not generate the voice (HTTP ${audioResponse.status}).`);
      if (!audioResponse.headers.get("content-type")?.toLowerCase().startsWith("audio/")) {
        throw new BridgeError("invalid_audio", "The voice provider did not return audio.");
      }
      const audio = await audioResponse.arrayBuffer();
      if (!audio.byteLength || audio.byteLength > 25 * 1024 * 1024) {
        throw new BridgeError("invalid_audio", "The voice provider returned empty or oversized audio.");
      }
      const storagePath = `voices/${Math.floor(this.now().getTime() / 1000)}-${noteId}.mp3`;
      const objectPath = `${encodeURIComponent(this.env.bucket)}/${storagePath}`;
      const uploaded = await this.request(`/storage/v1/object/${objectPath}`, {
        method: "POST", headers: { "Content-Type": "audio/mpeg", "x-upsert": "false" }, body: audio,
      });
      if (!uploaded.ok) throw new BridgeError("storage_failed", "The generated audio could not be confirmed in storage. Do not regenerate this offering.");
      const audioUrl = `${this.env.supabaseUrl}/storage/v1/object/public/${objectPath}`;
      const saved = await this.request("/rest/v1/voices", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ id: noteId, title, audio_url: audioUrl, storage_path: storagePath }),
      });
      if (!saved.ok) throw new BridgeError("save_uncertain", "Audio was uploaded, but the note save is unconfirmed. Do not regenerate this offering.");
      // Read back the exact row before reporting success, rather than trusting a POST alone.
      const verified = await this.fetch(noteId);
      if (verified.url !== audioUrl || (verified.metadata as Record<string, unknown>).storage_path !== storagePath) {
        throw new BridgeError("save_uncertain", "The saved note could not be verified. Do not regenerate this offering.");
      }
      await this.request(`/rest/v1/love_notes_bridge_requests?${new URLSearchParams({ idempotency_key: `eq.${key}`, status: "eq.pending" })}`, {
        method: "PATCH", body: JSON.stringify({ status: "completed", completed_at: this.now().toISOString() }),
      }).catch(() => undefined);
      return { id: noteId, audio_url: audioUrl, storage_path: storagePath, saved: true };
    } catch (error) {
      // Leave the reservation intact, including when the upstream outcome is uncertain.
      // No automatic retry, storage overwrite, or existing-note deletion is performed.
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("save_uncertain", "The offering was interrupted and its outcome is uncertain. Inspect the archive before any further attempt.");
    }
  }
}
