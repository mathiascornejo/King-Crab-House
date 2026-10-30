// Owner-only staff account management for the King Crab House page.
// Uses the service-role key (only available inside Supabase), so the page itself never holds it.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// must match emailFromName() in index.html
const LOGIN_DOMAIN = 'kingcrab.invalid';
const emailFromName = (n: string) => {
  const s = n.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  return s && `${s}@${LOGIN_DOMAIN}`;
};
const nameFromEmail = (e = '') => e.split('@')[0].split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const ROLES = ['owner', 'staff'];

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const { data: { user: caller } } = await admin.auth.getUser(token);
  if (caller?.app_metadata?.role !== 'owner') return json({ error: 'Only the owner can manage staff' }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const { action } = body;

  if (action === 'list') {
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
    if (error) return json({ error: error.message }, 500);
    return json({ users: data.users.map(u => ({
      id: u.id, name: nameFromEmail(u.email), role: u.app_metadata?.role ?? null, last_sign_in_at: u.last_sign_in_at, me: u.id === caller.id,
    })).sort((a, b) => a.name.localeCompare(b.name)) });
  }

  if (action === 'create') {
    const email = emailFromName(String(body.name ?? '')), password = String(body.password ?? ''), role = String(body.role ?? '');
    if (!email) return json({ error: 'Enter a name' }, 400);
    if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
    if (!ROLES.includes(role)) return json({ error: 'Pick owner or staff' }, 400);
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role } });
    if (error) return json({ error: /already/i.test(error.message) ? 'Someone with that name already exists' : error.message }, 400);
    return json({ id: data.user.id, name: nameFromEmail(email) });
  }

  const id = String(body.id ?? '');
  if (!id) return json({ error: 'Missing account' }, 400);

  if (action === 'reset_password') {
    const password = String(body.password ?? '');
    if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    return error ? json({ error: error.message }, 400) : json({ ok: true });
  }

  if (action === 'set_role') {
    const role = String(body.role ?? '');
    if (!ROLES.includes(role)) return json({ error: 'Pick owner or staff' }, 400);
    if (id === caller.id && role !== 'owner') return json({ error: "You can't remove your own owner access" }, 400);
    const { error } = await admin.auth.admin.updateUserById(id, { app_metadata: { role } });
    return error ? json({ error: error.message }, 400) : json({ ok: true });
  }

  if (action === 'remove') {
    if (id === caller.id) return json({ error: "You can't remove your own account" }, 400);
    const { error } = await admin.auth.admin.deleteUser(id);
    return error ? json({ error: error.message }, 400) : json({ ok: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
