import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';

// This is a publishable browser key, not a service-role or ElevenLabs secret.
const supabase = createClient(
  'https://vgvhvukccbtmvxkmgefb.supabase.co',
  'sb_publishable_9Uwkoo-qVLxTZVlAu3TlwQ_FeTmYPtx',
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
);
const authorizationId = new URL(location.href).searchParams.get('authorization_id');
const status = document.getElementById('status');
const login = document.getElementById('login');
const consent = document.getElementById('consent');
const approve = document.getElementById('approve');
const deny = document.getElementById('deny');
let details;
const scopeLabels = new Map([
  ['openid', 'Confirm your identity (openid)'],
  ['email', 'Share your owner account email address (email)'],
  ['offline_access', 'Keep this connection signed in using refresh tokens (offline_access)'],
]);

function redirect(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('The return address must use HTTPS.');
  location.replace(url.href);
}
function setBusy(busy) {
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
}
function failure(message) { status.textContent = message; }

async function loadRequest() {
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !data) throw new Error('This connection request is unavailable or expired. Start connecting again from your app.');
  if (!('authorization_id' in data)) { redirect(data.redirect_url); return; }
  const requested = [...new Set((data.scope || '').split(/\s+/).filter(Boolean))];
  if (!requested.includes('openid') || requested.some((scope) => !scopeLabels.has(scope))) {
    throw new Error('This request asks for permissions Love Notes does not support. Close this page and check the connection settings in your app.');
  }
  details = data;
  document.getElementById('client-name').textContent = data.client.name || 'Connecting app';
  document.getElementById('scopes').textContent = requested.map((scope) => scopeLabels.get(scope)).join('; ');
  document.getElementById('return-address').textContent = data.redirect_uri;
  login.hidden = true;
  consent.hidden = false;
  status.textContent = 'Review the app and return address before allowing access.';
}

login.addEventListener('submit', async (event) => {
  event.preventDefault(); setBusy(true);
  status.textContent = 'Signing in…';
  const password = document.getElementById('password');
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: document.getElementById('email').value.trim(), password: password.value,
    });
    password.value = '';
    if (error) throw new Error('Sign-in failed. Check your owner account email and password.');
    await loadRequest();
  } catch (error) { password.value = ''; failure(error.message || 'Sign-in could not be completed.'); }
  finally { setBusy(false); }
});

approve.addEventListener('click', async () => {
  if (!details) return;
  setBusy(true); status.textContent = 'Allowing the connection…';
  try {
    const { error: ownerError } = await supabase.rpc('approve_love_notes_oauth_client', { p_client_id: details.client.id });
    if (ownerError) throw new Error('Only the configured Love Notes owner can allow this connection.');
    const { data, error } = await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
    if (error || !data?.redirect_url) throw new Error('Approval could not be completed. Start connecting again from your app.');
    redirect(data.redirect_url);
  } catch (error) { failure(error.message || 'Approval could not be completed.'); setBusy(false); }
});

deny.addEventListener('click', async () => {
  setBusy(true); status.textContent = 'Declining the connection…';
  try {
    const { data, error } = await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
    if (error || !data?.redirect_url) throw new Error('Declining could not be completed. You can close this page without allowing access.');
    redirect(data.redirect_url);
  } catch (error) { failure(error.message || 'Declining could not be completed.'); setBusy(false); }
});

if (!authorizationId || authorizationId.length > 256) {
  status.textContent = 'Start connecting to Love Notes from your app. This page needs a current connection request.';
} else {
  status.textContent = 'Sign in to review this connection request.';
  login.hidden = false;
}
