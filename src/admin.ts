// CMS-session-gated admin surface: /__plugin/admin/checkin/*. Staff with a
// full CMS login manage check-in from here; the passcode-lite kiosk (public.ts)
// is the door-side surface that doesn't need one.

import { adminView, notFoundView, redirect, type CmsPage } from '@lionrockjs/worker-cms-plugin';
import { attr, checkins, CmsClient, computeGuestListSummary, emptyGuestListSummary, isAdhocGuestList, listByEvent, pointer, PLUGIN_ID } from './cms';
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
import { eventCustomFields, guestCustomFieldValue, type CustomField } from './custom-fields';
import { forbidden, type CheckinAccess } from './permissions';

const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;

export async function handleCheckinAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  segments: string[],
  url: URL,
  jsonOnly: boolean,
  access: CheckinAccess,
): Promise<Response> {
  const section = segments[0] || 'dashboard';

  if (section === 'dashboard') return dashboard(cms, views, jsonOnly);

  if (section === 'events') {
    const eventId = pageId(segments[1]);
    if (!eventId) return notFoundView(views, 'Event not found.', jsonOnly);
    return eventDashboard(cms, views, eventId, jsonOnly, access);
  }

  if (section === 'kiosk') {
    return handleKioskAdmin(cms, views, segments.slice(1), url, request, jsonOnly, access);
  }

  if (section === 'rsvp') {
    const listId = pageId(segments[1]);
    if (!listId) return notFoundView(views, 'Guest list not found.', jsonOnly);
    const sub = segments[2];

    if (sub === 'guests' && segments[3] === 'search') {
      return guestSearch(cms, views, listId, url, jsonOnly);
    }
    if (sub === 'guests' && segments[4] === 'checkin' && request.method === 'POST') {
      if (!access.canCheckIn) return new Response('Forbidden', { status: 403 });
      return manualCheckin(cms, listId, pageId(segments[3]), request);
    }
    if (sub === 'guests' && segments[4] === 'undo' && request.method === 'POST') {
      if (!access.canCheckIn) return new Response('Forbidden', { status: 403 });
      return manualUndo(cms, listId, pageId(segments[3]), request);
    }
  }

  return notFoundView(views, 'Page not found.', jsonOnly);
}

async function dashboard(cms: CmsClient, views: Fetcher, jsonOnly: boolean): Promise<Response> {
  const { pages: events } = await cms.list('event', { limit: 500 });
  const activeEvents = events.filter((event) => isActiveEvent(event));
  return adminView(views, 'Check-in', 'dashboard', {
    events: activeEvents.map((event) => ({
      id: event.id,
      name: event.name,
      href: `${ADMIN_BASE}/events/${event.id}`,
      kioskTitle: attr(event.lect, 'kiosk_title') || event.name,
      requiresLogin: attr(event.lect, 'checkin_require_login') === 'yes',
    })),
  }, jsonOnly);
}

function isActiveEvent(event: CmsPage, now = new Date()): boolean {
  const start = eventDateMs(event.start, event.timezone, 'start');
  const end = eventDateMs(event.end, event.timezone, 'end');
  const current = now.getTime();
  return start !== null && start <= current && (end === null || current <= end);
}

function eventDateMs(value: string | null, timezone: string | null, boundary: 'start' | 'end'): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const withTime = dateOnly
    ? `${raw}T${boundary === 'start' ? '00:00:00' : '23:59:59.999'}`
    : raw.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T').replace(/\s+([+-]\d{2}:?\d{2})$/, '$1');
  const withZone = hasTimezone(withTime) ? withTime : `${withTime}${normalizeTimezone(timezone)}`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

function hasTimezone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
}

function normalizeTimezone(timezone: string | null): string {
  const value = String(timezone ?? '').trim();
  if (/^[+-]\d{2}:?\d{2}$/.test(value)) return value;
  return 'Z';
}

async function eventDashboard(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly: boolean, access: CheckinAccess): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return notFoundView(views, 'Event not found.', jsonOnly);

  const lists = await listByEvent(cms, 'mail_list', eventId);
  const listSummaries = await Promise.all(
    lists.map(async (list) => {
      const { pages: guests } = await cms.list('guest', { pointer: { key: 'mail_list', value: list.id }, limit: 500 });
      return { list, guests, summary: computeGuestListSummary(guests) };
    }),
  );

  const activity = listSummaries
    .flatMap(({ list, guests }) => guests.flatMap((guest) => checkins(guest.lect).map((entry) => ({
      listName: list.name,
      guestName: guest.name,
      searchHref: `${ADMIN_BASE}/rsvp/${list.id}/guests/search?q=${encodeURIComponent(guest.name)}`,
      message: String(entry.message ?? ''),
      date: String(entry.date ?? ''),
    }))))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 20);

  // Whole-event totals (the "Event Summary" card), aggregated from the
  // per-list tallies computeGuestListSummary already produced.
  const summary = listSummaries.reduce((acc, { summary: s }) => ({
    guest_count: acc.guest_count + s.guest_count,
    guest_total: acc.guest_total + s.guest_total,
    checked_in_count: acc.checked_in_count + s.checked_in_count,
    checked_in_total: acc.checked_in_total + s.checked_in_total,
  }), emptyGuestListSummary());
  const checkedInPercent = summary.guest_count > 0 ? Math.round((summary.checked_in_count / summary.guest_count) * 100) : 0;

  const kioskBase = `${ADMIN_BASE}/kiosk/${event.id}`;
  const customFields = eventCustomFields(event, lists);

  // The kiosk is scoped to the whole event (scan/search cross every guest
  // list on it — see handleKioskAdmin), not to one list, so there's a single
  // kiosk link per event rather than one per list. It's a same-origin admin
  // route now (login-gated), so a plain relative path.
  return adminView(views, `Check-in — ${event.name}`, 'event-dashboard', {
    eventId: event.id,
    eventName: event.name,
    kioskTitle: attr(event.lect, 'kiosk_title') || event.name,
    canCheckIn: access.canCheckIn,
    launchKioskHref: `${kioskBase}/scan`,
    // Bottom nav + top search targets.
    dashboardHref: `${ADMIN_BASE}/dashboard`,
    scanHref: `${kioskBase}/scan`,
    settingsHref: `${kioskBase}/settings`,
    searchHref: `${kioskBase}/search`,
    walkinHref: `${kioskBase}/adhoc-guest`,
    customFields: customFields.map((field) => ({ value: field.key, label: field.label })),
    hasCustomFields: customFields.length > 0,
    summary: {
      guestCount: summary.guest_count,
      guestTotal: summary.guest_total,
      checkedInCount: summary.checked_in_count,
      checkedInTotal: summary.checked_in_total,
      checkedInPercent,
    },
    sessions: checkinSessions(event),
    lists: listSummaries.map(({ list, summary: s }) => ({
      id: list.id,
      name: list.name,
      allowCheckin: attr(list.lect, 'allow_checkin') !== 'no',
      searchHref: `${ADMIN_BASE}/rsvp/${list.id}/guests/search`,
      checkedIn: s.checked_in_count,
      total: s.guest_count,
      checkedInHeadcount: s.checked_in_total,
      totalHeadcount: s.guest_total,
    })),
    activity,
  }, jsonOnly);
}

async function guestSearch(cms: CmsClient, views: Fetcher, listId: number, url: URL, jsonOnly: boolean): Promise<Response> {
  const list = await cms.get(listId);
  if (list.page_type !== 'mail_list') return notFoundView(views, 'Guest list not found.', jsonOnly);
  const q = url.searchParams.get('q') ?? '';
  const guests = q ? await searchGuests(cms, listId, q) : [];

  return adminView(views, `Search — ${list.name}`, 'guest-search', {
    listName: list.name,
    listId,
    query: q,
    searchAction: `${ADMIN_BASE}/rsvp/${listId}/guests/search`,
    returnTo: `${ADMIN_BASE}/rsvp/${listId}/guests/search${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    checkinAction: `${ADMIN_BASE}/rsvp/${listId}/guests`,
    guests: guests.map((guest) => ({
      id: guest.id,
      name: guest.name,
      organization: attr(guest.lect, 'organization'),
      email: attr(guest.lect, 'email'),
      checkedIn: mainCheckinCount(guest) > 0,
      plusGuestsCap: plusGuestsCap(guest),
    })),
  }, jsonOnly);
}

async function manualCheckin(cms: CmsClient, listId: number, guestId: number | null, request: Request): Promise<Response> {
  if (!guestId) return new Response('not found', { status: 404 });
  const guest = await requireGuestInList(cms, listId, guestId);
  if (!guest) return new Response('not found', { status: 404 });

  if (mainCheckinCount(guest) === 0) await recordCheckin(cms, guest, formatMainMessage('kiosk'));

  const form = await request.formData().catch(() => null);
  const returnTo = safeAdminReturn(form?.get('return_to')) || `${ADMIN_BASE}/rsvp/${listId}/guests/search`;
  return redirect(returnTo);
}

async function manualUndo(cms: CmsClient, listId: number, guestId: number | null, request: Request): Promise<Response> {
  if (!guestId) return new Response('not found', { status: 404 });
  const guest = await requireGuestInList(cms, listId, guestId);
  if (!guest) return new Response('not found', { status: 404 });

  await undoCheckin(cms, guest, (parsed) => parsed.kind === 'main');

  const form = await request.formData().catch(() => null);
  const returnTo = safeAdminReturn(form?.get('return_to')) || `${ADMIN_BASE}/rsvp/${listId}/guests/search`;
  return redirect(returnTo);
}

async function requireGuestInList(cms: CmsClient, listId: number, guestId: number): Promise<CmsPage | null> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || guest.page_id !== listId) return null;
  return guest;
}

// ── Kiosk (login-gated door-staff surface) ──────────────────────────────────
// Formerly the passcode-lite public kiosk on the plugin's own domain; now a
// CMS-session admin surface wrapped in the host chrome. The kiosk is scoped to
// a whole event — scan/search cross every guest list on it. The scan page opts
// into the camera (x-cms-permissions) so the host relaxes the admin CSP for it.

const KIOSK_BASE = ADMIN_BASE + '/kiosk';

async function handleKioskAdmin(
  cms: CmsClient,
  views: Fetcher,
  segments: string[],
  url: URL,
  request: Request,
  jsonOnly: boolean,
  access: CheckinAccess,
): Promise<Response> {
  const eventId = pageId(segments[0]);
  if (!eventId) return notFoundView(views, 'Event not found.', jsonOnly);

  const event = await cms.get(eventId).catch(() => null);
  if (!event || event.page_type !== 'event') return notFoundView(views, 'Event not found.', jsonOnly);

  const sub = segments[1];
  if (!sub || sub === 'scan') return kioskScan(cms, views, event, request, jsonOnly, access);
  if (sub === 'search') return kioskSearch(cms, views, event, url, jsonOnly);
  if (sub === 'settings') return kioskView(views, `Settings — ${event.name}`, 'kiosk-settings', {
    eventName: event.name,
    backHref: `${KIOSK_BASE}/${event.id}/scan`,
    searchHref: `${KIOSK_BASE}/${event.id}/search`,
  }, jsonOnly);
  if (sub === 'adhoc-guest') {
    if (!access.canCheckIn) return forbidden();
    return kioskAdhocGuest(cms, views, event, request, jsonOnly);
  }
  if (sub === 'guests') return kioskGuest(cms, views, event, segments.slice(2), request, jsonOnly, access);

  return notFoundView(views, 'Page not found.', jsonOnly);
}

/**
 * A kiosk client-view, optionally flagged as needing the camera. adminView
 * returns a mutable JSON client-view Response; the `camera` flag adds the
 * opt-in header the host translates into a relaxed (camera + wasm) CSP for
 * just this page. No effect on the `jsonOnly` (raw data) response.
 */
async function kioskView(
  views: Fetcher,
  title: string,
  template: string,
  data: Record<string, unknown>,
  jsonOnly: boolean,
  opts: { camera?: boolean } = {},
): Promise<Response> {
  const response = await adminView(views, title, template, data, jsonOnly);
  if (opts.camera && !jsonOnly) response.headers.set('x-cms-permissions', 'camera');
  return response;
}

async function kioskScan(cms: CmsClient, views: Fetcher, event: CmsPage, request: Request, jsonOnly: boolean, access: CheckinAccess): Promise<Response> {
  const data = {
    eventName: event.name,
    eventId: event.id,
    searchHref: `${KIOSK_BASE}/${event.id}/search`,
    settingsHref: `${KIOSK_BASE}/${event.id}/settings`,
    scanAction: `${KIOSK_BASE}/${event.id}/scan`,
    adhocHref: `${KIOSK_BASE}/${event.id}/adhoc-guest`,
    canCheckIn: access.canCheckIn,
    error: '',
  };
  if (request.method === 'POST') {
    const form = await request.formData();
    const code = String(form.get('code') ?? '').trim();
    const guest = code ? await findGuestByCodeInEvent(cms, event.id, code) : null;
    if (guest) return redirect(`${KIOSK_BASE}/${event.id}/guests/${guest.id}`);
    return kioskView(views, event.name, 'kiosk-scan', { ...data, error: 'No guest found for that code.' }, jsonOnly, { camera: true });
  }
  return kioskView(views, event.name, 'kiosk-scan', data, jsonOnly, { camera: true });
}

async function kioskSearch(cms: CmsClient, views: Fetcher, event: CmsPage, url: URL, jsonOnly: boolean): Promise<Response> {
  const q = url.searchParams.get('q') ?? '';
  // `field` selects a custom-field search (match that field's value) instead of
  // the default name/email/organization/phone search.
  const fieldParam = url.searchParams.get('field')?.trim() ?? '';
  const lists = q ? await listByEvent(cms, 'mail_list', event.id) : [];
  const customField = fieldParam
    ? eventCustomFields(event, lists).find((field) => field.key === fieldParam || field.legacyKey === fieldParam) ?? null
    : null;

  const guests: Array<{ id: number; name: string; organization: string; listName: string; checkedIn: boolean; guestHref: string }> = [];
  for (const list of lists) {
    const matches = customField
      ? await searchGuestsByCustomField(cms, list.id, customField, q)
      : await searchGuests(cms, list.id, q);
    for (const guest of matches) {
      guests.push({
        id: guest.id,
        name: guest.name,
        organization: attr(guest.lect, 'organization'),
        listName: list.name,
        checkedIn: mainCheckinCount(guest) > 0,
        guestHref: `${KIOSK_BASE}/${event.id}/guests/${guest.id}`,
      });
    }
  }
  return kioskView(views, `Search — ${event.name}`, 'kiosk-search', {
    eventName: event.name,
    eventId: event.id,
    query: q,
    field: customField ? customField.key : '',
    fieldLabel: customField ? customField.label : '',
    guests,
    scanHref: `${KIOSK_BASE}/${event.id}/scan`,
    settingsHref: `${KIOSK_BASE}/${event.id}/settings`,
  }, jsonOnly);
}

/** Guests on a list whose custom-field value contains `q` (case-insensitive). */
async function searchGuestsByCustomField(cms: CmsClient, listId: number, field: CustomField, q: string): Promise<CmsPage[]> {
  const { pages } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, limit: 500 });
  const needle = q.trim().toLowerCase();
  return pages.filter((guest) => {
    const value = guestCustomFieldValue(guest, field).toLowerCase();
    return value !== '' && value.includes(needle);
  });
}

async function kioskAdhocGuest(cms: CmsClient, views: Fetcher, event: CmsPage, request: Request, jsonOnly: boolean): Promise<Response> {
  if (request.method !== 'POST') return new Response('not found', { status: 404 });
  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  if (!name) return redirect(`${KIOSK_BASE}/${event.id}/scan`);

  const lists = await listByEvent(cms, 'mail_list', event.id);
  const target = lists.find(isAdhocGuestList);
  if (!target) return adminView(views, 'Check-in', 'error', { message: 'No default guest list configured for this event yet. Add one in the CMS admin first.' }, jsonOnly);

  const guest = await createWalkInGuest(cms, target.id, {
    name,
    email: String(form.get('email') ?? '').trim(),
    phone: String(form.get('phone') ?? '').trim(),
    organization: String(form.get('organization') ?? '').trim(),
    plusGuests: Number.parseInt(String(form.get('plus_guests') ?? '0'), 10) || 0,
  });
  if (form.get('checkin') === '1') await recordCheckin(cms, guest, formatMainMessage('kiosk'));

  return redirect(`${KIOSK_BASE}/${event.id}/guests/${guest.id}`);
}

async function kioskGuest(cms: CmsClient, views: Fetcher, event: CmsPage, rest: string[], request: Request, jsonOnly: boolean, access: CheckinAccess): Promise<Response> {
  const guestId = pageId(rest[0]);
  if (!guestId) return notFoundView(views, 'Guest not found.', jsonOnly);

  let guest = await cms.get(guestId).catch(() => null);
  if (!guest || guest.page_type !== 'guest') return notFoundView(views, 'Guest not found.', jsonOnly);

  // Guest's own mail_list must belong to this event — keeps one event's kiosk
  // from reaching into another event's guests via a guessed guest id.
  const list = guest.page_id ? await cms.get(guest.page_id).catch(() => null) : null;
  if (!list || list.page_type !== 'mail_list' || pointer(list.lect, 'event') !== String(event.id)) {
    return notFoundView(views, 'Guest not found.', jsonOnly);
  }

  const action = rest[1];

  if (action === 'badge') return renderBadge(cms, event, guest);

  if (action && request.method === 'POST') {
    if (!access.canCheckIn) return forbidden();
    guest = await performGuestAction(cms, guest, event, action, request);
    return redirect(`${KIOSK_BASE}/${event.id}/guests/${guest.id}`);
  }

  return renderKioskGuest(views, event, guest, jsonOnly, access);
}

async function performGuestAction(cms: CmsClient, guest: CmsPage, event: CmsPage, action: string, request: Request): Promise<CmsPage> {
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
  if (action === 'checkin-session') {
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

async function renderKioskGuest(views: Fetcher, event: CmsPage, guest: CmsPage, jsonOnly: boolean, access: CheckinAccess): Promise<Response> {
  const cap = plusGuestsCap(guest);
  const plusGuests = Array.from({ length: cap }, (_, index) => ({
    index,
    label: `Plus guest ${index + 1}`,
    checkedIn: plusCheckinCount(guest, index) > 0,
  }));
  const sessions = checkinSessions(event).map((session) => ({ ...session, checkedIn: sessionCheckinCount(guest, session.id) > 0 }));
  const actionBase = `${KIOSK_BASE}/${event.id}/guests/${guest.id}`;

  return kioskView(views, guest.name, 'kiosk-guest', {
    eventId: event.id,
    guestId: guest.id,
    guestName: guest.name,
    organization: attr(guest.lect, 'organization'),
    email: attr(guest.lect, 'email'),
    canCheckIn: access.canCheckIn,
    mainCheckedIn: mainCheckinCount(guest) > 0,
    mainAtCap: mainCheckinCount(guest) >= maxMainCheckins(guest),
    plusGuests,
    hasPlusGuests: plusGuests.length > 0,
    sessions,
    hasSessions: sessions.length > 0,
    rfid: attr(guest.lect, 'barcode'),
    actionBase,
    backHref: `${KIOSK_BASE}/${event.id}/scan`,
    searchHref: `${KIOSK_BASE}/${event.id}/search`,
    badgeHref: `${actionBase}/badge`,
    settingsHref: `${KIOSK_BASE}/${event.id}/settings`,
  }, jsonOnly);
}

async function renderBadge(cms: CmsClient, event: CmsPage, guest: CmsPage): Promise<Response> {
  const labels = await eventLabels(cms, event.id);
  if (!labels.length) return new Response('No badge template configured for this event yet.', { status: 404 });
  const frame = labelFrame(labels[0]);
  const svg = renderLabel(frame.svg, guestTokens(guest));
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } });
}

/** Scans every guest list on the event, in order, for a guest whose qrcode/barcode matches. */
async function findGuestByCodeInEvent(cms: CmsClient, eventId: number, code: string): Promise<CmsPage | null> {
  const lists = await listByEvent(cms, 'mail_list', eventId);
  for (const list of lists) {
    const guest = await findGuestByCode(cms, list.id, code);
    if (guest) return guest;
  }
  return null;
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Only honours same-origin `/admin*` return paths, matching cms-plugin-events' guard. */
function safeAdminReturn(value: unknown): string {
  const path = typeof value === 'string' ? value.trim() : '';
  return path.startsWith('/admin') ? path : '';
}
