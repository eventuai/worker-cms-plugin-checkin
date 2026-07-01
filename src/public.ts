// Public, non-CMS-authenticated surface: the own-domain routes guests and
// door staff actually hit.
//
// /checkin/{listId}/{guestId}/{sig}            — direct QR link cms-plugin-events
// /checkin/{listId}/{guestId}/{index}/{sig}       already mints (see qr-links.ts)
// /kiosk/{listId}[/...]                         — passcode-lite kiosk (kiosk-session.ts)

import { redirect, pointer, attr, type CmsPage } from '@lionrockjs/worker-cms-plugin';
import { CmsClient, type CmsClientEnv } from './cms';
import { resolveCheckinLink } from './qr-links';
import { hasKioskSession, mintKioskCookie } from './kiosk-session';
import {
  checkinSessions,
  createWalkInGuest,
  findGuestByCode,
  formatMainMessage,
  formatPlusMessage,
  formatSessionMessage,
  mainCheckinCount,
  maxMainCheckins,
  plusCheckinCount,
  plusGuestsCap,
  recordCheckin,
  saveRfid,
  searchGuests,
  sessionCheckinCount,
  undoCheckin,
} from './checkin-actions';
import { eventLabels, guestTokens, labelFrame, renderLabel } from './labels';
import { renderLiquid } from './templates/liquid';

export interface PublicEnv extends CmsClientEnv {
  /** Copy of cms-plugin-events' PLUGIN_SECRET — verifies its already-minted guest QR links. See wrangler.toml. */
  EVENTS_PLUGIN_SECRET?: string;
  VIEWS: Fetcher;
}

/** Returns null (not handled) so the caller can fall through to its own 404. */
export async function handlePublicCheckin(request: Request, env: PublicEnv, url: URL): Promise<Response | null> {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'checkin') return handleDirectCheckin(request, env, segments.slice(1));
  if (segments[0] === 'kiosk') return handleKiosk(request, env, segments.slice(1), url);
  return null;
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

// ── Kiosk ───────────────────────────────────────────────────────────────────

async function handleKiosk(request: Request, env: PublicEnv, segments: string[], url: URL): Promise<Response> {
  const listId = pageId(segments[0]);
  if (!listId) return notFound();

  const cms = new CmsClient(env);
  let list: CmsPage;
  try {
    list = await cms.get(listId);
  } catch {
    return notFound();
  }
  if (list.page_type !== 'mail_list') return notFound();

  const sub = segments[1];
  if (!sub) return handlePasscode(request, env, list);

  if (!(await hasKioskSession(request, env.PLUGIN_SECRET ?? '', listId))) return redirect(`/kiosk/${listId}`);

  if (sub === 'scan') return handleScan(request, cms, env, list);
  if (sub === 'search') return handleSearch(cms, env, list, url);
  if (sub === 'settings') return html(await renderLiquid(env.VIEWS, '/templates/kiosk-settings.liquid', { listName: list.name, backHref: `/kiosk/${listId}/scan` }));
  if (sub === 'adhoc-guest') return handleAdhocGuest(request, cms, list);
  if (sub === 'guests') return handleGuestDetail(request, cms, env, list, segments.slice(2));

  return notFound();
}

async function handlePasscode(request: Request, env: PublicEnv, list: CmsPage): Promise<Response> {
  const listId = list.id;
  if (await hasKioskSession(request, env.PLUGIN_SECRET ?? '', listId)) return redirect(`/kiosk/${listId}/scan`);

  const expected = attr(list.lect, 'checkin_lite_passcode').trim();
  if (!expected) return html(renderMessage('This guest list has no kiosk passcode set yet. Set one in the Events admin.'));

  if (request.method === 'POST') {
    const form = await request.formData();
    const submitted = String(form.get('passcode') ?? '').trim();
    if (submitted && submitted === expected) {
      const cookie = await mintKioskCookie(env.PLUGIN_SECRET ?? '', listId);
      return new Response(null, { status: 303, headers: { location: `/kiosk/${listId}/scan`, 'set-cookie': cookie } });
    }
    return html(await renderLiquid(env.VIEWS, '/templates/kiosk-passcode.liquid', { listName: list.name, listId, error: 'Incorrect passcode.' }));
  }

  return html(await renderLiquid(env.VIEWS, '/templates/kiosk-passcode.liquid', { listName: list.name, listId, error: '' }));
}

async function handleScan(request: Request, cms: CmsClient, env: PublicEnv, list: CmsPage): Promise<Response> {
  const data = {
    listName: list.name,
    listId: list.id,
    searchHref: `/kiosk/${list.id}/search`,
    settingsHref: `/kiosk/${list.id}/settings`,
    adhocHref: `/kiosk/${list.id}/adhoc-guest`,
  };
  if (request.method === 'POST') {
    const form = await request.formData();
    const code = String(form.get('code') ?? '').trim();
    const guest = code ? await findGuestByCode(cms, list.id, code) : null;
    if (guest) return redirect(`/kiosk/${list.id}/guests/${guest.id}`);
    return html(await renderLiquid(env.VIEWS, '/templates/kiosk-scan.liquid', { ...data, error: 'No guest found for that code.' }));
  }
  return html(await renderLiquid(env.VIEWS, '/templates/kiosk-scan.liquid', { ...data, error: '' }));
}

async function handleSearch(cms: CmsClient, env: PublicEnv, list: CmsPage, url: URL): Promise<Response> {
  const q = url.searchParams.get('q') ?? '';
  const guests = q ? await searchGuests(cms, list.id, q) : [];
  return html(await renderLiquid(env.VIEWS, '/templates/kiosk-search.liquid', {
    listName: list.name,
    listId: list.id,
    query: q,
    guests: guests.map((guest) => ({
      id: guest.id,
      name: guest.name,
      organization: attr(guest.lect, 'organization'),
      checkedIn: mainCheckinCount(guest) > 0,
    })),
  }));
}

async function handleAdhocGuest(request: Request, cms: CmsClient, list: CmsPage): Promise<Response> {
  if (request.method !== 'POST') return notFound();
  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  if (!name) return redirect(`/kiosk/${list.id}/scan`);

  const guest = await createWalkInGuest(cms, list.id, {
    name,
    email: String(form.get('email') ?? '').trim(),
    phone: String(form.get('phone') ?? '').trim(),
    organization: String(form.get('organization') ?? '').trim(),
    plusGuests: Number.parseInt(String(form.get('plus_guests') ?? '0'), 10) || 0,
  });
  if (form.get('checkin') === '1') await recordCheckin(cms, guest, formatMainMessage('kiosk'));

  return redirect(`/kiosk/${list.id}/guests/${guest.id}`);
}

async function handleGuestDetail(request: Request, cms: CmsClient, env: PublicEnv, list: CmsPage, rest: string[]): Promise<Response> {
  const guestId = pageId(rest[0]);
  if (!guestId) return notFound();

  let guest = await cms.get(guestId).catch(() => null);
  if (!guest || guest.page_type !== 'guest' || guest.page_id !== list.id) return notFound();

  const event = await eventForList(cms, list);
  const action = rest[1];

  if (action === 'badge') return renderBadge(cms, event, guest);

  if (action && request.method === 'POST') {
    guest = await performGuestAction(cms, guest, event, action, request);
    return redirect(`/kiosk/${list.id}/guests/${guest.id}`);
  }

  return html(await renderGuestDetail(env, list, event, guest));
}

async function performGuestAction(cms: CmsClient, guest: CmsPage, event: CmsPage | null, action: string, request: Request): Promise<CmsPage> {
  const form = await request.formData().catch(() => null);

  if (action === 'checkin-main') {
    if (mainCheckinCount(guest) < maxMainCheckins(guest)) return recordCheckin(cms, guest, formatMainMessage('kiosk'));
    return guest;
  }
  if (action === 'undo-main') {
    return (await undoCheckin(cms, guest, (parsed) => parsed.kind === 'main')).guest;
  }
  if (action === 'checkin-plus') {
    const index = Number.parseInt(String(form?.get('index') ?? ''), 10);
    const name = String(form?.get('name') ?? '').trim() || undefined;
    if (Number.isInteger(index) && index >= 0 && index < plusGuestsCap(guest) && plusCheckinCount(guest, index) === 0) {
      return recordCheckin(cms, guest, formatPlusMessage(index, 'kiosk', name));
    }
    return guest;
  }
  if (action === 'undo-plus') {
    const index = Number.parseInt(String(form?.get('index') ?? ''), 10);
    return (await undoCheckin(cms, guest, (parsed) => parsed.kind === 'plus' && parsed.index === index)).guest;
  }
  if (action === 'checkin-session' && event) {
    const sessionId = String(form?.get('session_id') ?? '');
    const session = checkinSessions(event).find((candidate) => candidate.id === sessionId);
    if (session && sessionCheckinCount(guest, sessionId) === 0) return recordCheckin(cms, guest, formatSessionMessage(session.id, session.name));
    return guest;
  }
  if (action === 'undo-session') {
    const sessionId = String(form?.get('session_id') ?? '');
    return (await undoCheckin(cms, guest, (parsed) => parsed.kind === 'session' && parsed.sessionId === sessionId)).guest;
  }
  if (action === 'save-rfid') {
    const tag = String(form?.get('tag') ?? '').trim();
    if (tag) return saveRfid(cms, guest, tag);
    return guest;
  }
  return guest;
}

async function renderGuestDetail(env: PublicEnv, list: CmsPage, event: CmsPage | null, guest: CmsPage): Promise<string> {
  const cap = plusGuestsCap(guest);
  const plusGuests = Array.from({ length: cap }, (_, index) => ({
    index,
    label: `Plus guest ${index + 1}`,
    checkedIn: plusCheckinCount(guest, index) > 0,
  }));
  const sessions = event ? checkinSessions(event).map((session) => ({ ...session, checkedIn: sessionCheckinCount(guest, session.id) > 0 })) : [];

  return renderLiquid(env.VIEWS, '/templates/kiosk-guest.liquid', {
    listId: list.id,
    guestId: guest.id,
    guestName: guest.name,
    organization: attr(guest.lect, 'organization'),
    email: attr(guest.lect, 'email'),
    mainCheckedIn: mainCheckinCount(guest) > 0,
    mainAtCap: mainCheckinCount(guest) >= maxMainCheckins(guest),
    plusGuests,
    hasPlusGuests: plusGuests.length > 0,
    sessions,
    hasSessions: sessions.length > 0,
    rfid: attr(guest.lect, 'barcode'),
    backHref: `/kiosk/${list.id}/scan`,
    searchHref: `/kiosk/${list.id}/search`,
    badgeHref: `/kiosk/${list.id}/guests/${guest.id}/badge`,
    settingsHref: `/kiosk/${list.id}/settings`,
  });
}

async function renderBadge(cms: CmsClient, event: CmsPage | null, guest: CmsPage): Promise<Response> {
  if (!event) return html(renderMessage('No event found for this guest.'), 404);
  const labels = await eventLabels(cms, event.id);
  if (!labels.length) return html(renderMessage('No badge template configured for this event yet.'), 404);
  const frame = labelFrame(labels[0]);
  const svg = renderLabel(frame.svg, guestTokens(guest));
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } });
}

async function eventForList(cms: CmsClient, list: CmsPage): Promise<CmsPage | null> {
  const eventId = Number(pointer(list.lect, 'event'));
  if (!Number.isInteger(eventId) || eventId <= 0) return null;
  const event = await cms.get(eventId).catch(() => null);
  return event && event.page_type === 'event' ? event : null;
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

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
