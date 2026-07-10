// Public, non-CMS-authenticated surface: the own-domain routes guests actually
// hit.
//
// /checkin/{listId}/{guestId}/{sig}            — direct QR link cms-plugin-events
// /checkin/{listId}/{guestId}/{index}/{sig}       already mints (see qr-links.ts)
//
// The passcode-lite kiosk that used to live here (/kiosk/*) moved into the
// login-gated CMS admin surface (see admin.ts handleKioskAdmin); only the
// guest-facing QR links remain public.

import { attr, soleTenant, tenantByRef, tenantClientEnv, type CmsPage } from '@lionrockjs/worker-cms-plugin';
import { CmsClient, type CmsClientEnv } from './cms';
import { resolveCheckinLink } from './qr-links';
import {
  formatMainMessage,
  formatPlusMessage,
  mainCheckinCount,
  maxMainCheckins,
  plusCheckinCount,
  plusGuestsCap,
  recordCheckin,
} from './checkin-actions';
import { renderLiquid } from './templates/liquid';

export interface PublicEnv extends CmsClientEnv {
  /** Copy of cms-plugin-events' signKey (legacy: its PLUGIN_SECRET) — verifies
   *  its already-minted guest QR links. Multi-tenant installs set it per
   *  tenant via the TENANTS record's `vars.EVENTS_PLUGIN_SECRET` instead. */
  EVENTS_PLUGIN_SECRET?: string;
  /** Multi-tenant registry: `tenant:<cms origin>` → TenantConfig JSON. */
  TENANTS?: KVNamespace;
  VIEWS: Fetcher;
}

/** Returns null (not handled) so the caller can fall through to its own 404. */
export async function handlePublicCheckin(request: Request, env: PublicEnv, url: URL): Promise<Response | null> {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'checkin') return null;

  // Multi-tenant: QR links minted by cms-plugin-events carry `?t=<ref>`; the
  // ref picks the tenant whose keys verify the link and whose CMS the
  // check-in writes to. Links without a ref (already-printed badges) resolve
  // while exactly one tenant is configured. The ref is only a routing hint —
  // a swapped ref makes the signature check fail under the other tenant's key.
  const ref = url.searchParams.get('t') ?? '';
  const tenant = ref ? await tenantByRef(env, ref) : await soleTenant(env);
  if (!tenant) return new Response('not found', { status: 404 });
  return handleDirectCheckin(request, tenantClientEnv(env, tenant), segments.slice(1));
}

// ── Direct QR check-in ─────────────────────────────────────────────────────

async function handleDirectCheckin(request: Request, env: PublicEnv, segments: string[]): Promise<Response> {
  const link = await resolveCheckinLink(segments, env.EVENTS_PLUGIN_SECRET);
  if (!link) return notFound();

  const cms = new CmsClient(env);
  let list: CmsPage;
  let guest: CmsPage;
  try {
    [list, guest] = await Promise.all([cms.get(link.listId), cms.get(link.guestId)]);
  } catch {
    return notFound();
  }
  if (list.page_type !== 'mail_list' || guest.page_type !== 'guest' || guest.page_id !== link.listId) return notFound();
  if (attr(list.lect, 'allow_checkin') === 'no') return html(renderMessage('Check-in is disabled for this guest list.'));

  if (link.kind === 'main') {
    if (request.method === 'POST' && mainCheckinCount(guest) < maxMainCheckins(guest)) {
      guest = await recordCheckin(cms, guest, formatMainMessage('qr'));
    }
    return html(await renderLiquid(env.VIEWS, '/templates/checkin-confirm.liquid', {
      guestName: guest.name,
      organization: attr(guest.lect, 'organization'),
      label: 'Main attendee',
      checkedIn: mainCheckinCount(guest) > 0,
    }));
  }

  const cap = plusGuestsCap(guest);
  if (link.index >= cap) return html(renderMessage('This code is not valid for this guest.'));
  if (request.method === 'POST' && plusCheckinCount(guest, link.index) === 0) {
    guest = await recordCheckin(cms, guest, formatPlusMessage(link.index, 'qr'));
  }
  return html(await renderLiquid(env.VIEWS, '/templates/checkin-confirm.liquid', {
    guestName: guest.name,
    organization: attr(guest.lect, 'organization'),
    label: `Plus guest ${link.index + 1}`,
    checkedIn: plusCheckinCount(guest, link.index) > 0,
  }));
}

// ── Small helpers ────────────────────────────────────────────────────────

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function renderMessage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Check-in</title>
<style>body{margin:0;background:#f3f4f6;font-family:system-ui,sans-serif;font-size:16px;color:#111827}.card{max-width:28rem;margin:3rem auto;background:#fff;padding:2rem;border-radius:1rem;box-shadow:0 1px 3px #0002;text-align:center}</style></head>
<body><main class="card"><p>${escapeHtml(message)}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] as string));
}

function notFound(): Response {
  return new Response('not found', { status: 404 });
}
