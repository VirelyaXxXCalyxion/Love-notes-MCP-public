-- This bridge reuses public.voices and the existing love-notes bucket.
-- It starts disabled until the owner's Auth account and OAuth connection exist.
create table public.love_notes_bridge_settings (
  id boolean primary key default true check (id),
  owner_id uuid references auth.users(id) on delete set null,
  oauth_client_ids text[] not null default '{}',
  resource_url text not null default '',
  enabled boolean not null default false
);
alter table public.love_notes_bridge_settings enable row level security;
revoke all on public.love_notes_bridge_settings from public, anon, authenticated;
grant all on public.love_notes_bridge_settings to service_role;
grant select on public.love_notes_bridge_settings to supabase_auth_admin;
create policy "Auth hook reads bridge settings"
  on public.love_notes_bridge_settings for select to supabase_auth_admin using (true);
insert into public.love_notes_bridge_settings (id) values (true);

-- Claims survive interrupted requests so a timeout cannot silently regenerate
-- the same offering. No text, audio, or API keys are stored in this table.
create table public.love_notes_bridge_requests (
  idempotency_key text primary key check (idempotency_key ~ '^[0-9a-f]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  owner_id uuid not null references auth.users(id),
  note_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((status = 'pending' and completed_at is null) or
         (status = 'completed' and completed_at is not null))
);
alter table public.love_notes_bridge_requests enable row level security;
revoke all on public.love_notes_bridge_requests from public, anon, authenticated;
grant all on public.love_notes_bridge_requests to service_role;

-- Supabase calls this hook for every token. Only tokens for the configured
-- owner AND an explicitly approved OAuth client get the MCP audience.
-- Ordinary sign-ins and unrelated clients retain their original claims.
create function public.love_notes_mcp_access_token_hook(event jsonb)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare
  settings public.love_notes_bridge_settings;
  claims jsonb := event -> 'claims';
  client_id text := coalesce(event ->> 'client_id', event -> 'claims' ->> 'client_id');
  user_id text := coalesce(event ->> 'user_id', event -> 'claims' ->> 'sub');
begin
  select * into settings from public.love_notes_bridge_settings where id = true;
  if settings.enabled and settings.resource_url <> '' and
     settings.owner_id::text = user_id and
     client_id = any(settings.oauth_client_ids) then
    claims := jsonb_set(claims, '{aud}', to_jsonb(settings.resource_url));
    -- Supabase's OAuth access JWT contains client_id but does not consistently
    -- contain a scope claim. This bridge requests only the OIDC openid scope.
    claims := jsonb_set(claims, '{scope}', '"openid"'::jsonb);
    return jsonb_set(event, '{claims}', claims);
  end if;
  return event;
end;
$$;
grant usage on schema public to supabase_auth_admin;
revoke all on function public.love_notes_mcp_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.love_notes_mcp_access_token_hook(jsonb) to supabase_auth_admin;

-- This narrowly scoped definer function is the consent page's sole write:
-- an ordinary, signed-in owner may approve one registered OAuth client.
-- The owner cannot be changed here, and other users cannot call it successfully.
create function public.approve_love_notes_oauth_client(p_client_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  settings public.love_notes_bridge_settings;
begin
  select * into settings from public.love_notes_bridge_settings where id = true for update;
  if auth.uid() is null or auth.uid() is distinct from settings.owner_id or
     not settings.enabled or settings.resource_url = '' or
     nullif(auth.jwt() ->> 'client_id', '') is not null then
    raise exception 'Only the signed-in bridge owner can approve this connection.' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.oauth_clients where id = p_client_id and deleted_at is null) then
    raise exception 'The OAuth client is not registered.' using errcode = '22023';
  end if;
  update public.love_notes_bridge_settings
    set oauth_client_ids = array(select distinct unnest(oauth_client_ids || p_client_id::text))
    where id = true;
end;
$$;
revoke all on function public.approve_love_notes_oauth_client(uuid) from public, anon;
grant execute on function public.approve_love_notes_oauth_client(uuid) to authenticated;
