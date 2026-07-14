// CMS-session-gated admin surface: /__plugin/admin/checkin/*. Staff with a
// full CMS login manage check-in from here; the passcode-lite kiosk (public.ts)
// is the door-side surface that doesn't need one.

import { adminView, compareByWeightThenName, notFoundView, redirect, type CmsPage } from '@lionrockjs/worker-cms-plugin';
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
import { eventLabels, guestTokens, labelDesign, labelFrame, renderLabel } from './labels';
import { eventCustomFields, guestCustomFieldValue, type CustomField } from './custom-fields';
import { chineseSearchText } from './chinese';
import { forbidden, type CheckinAccess } from './permissions';
import { resolveCheckinCode } from './qr-links';

const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;
const GUEST_STATUSES = ['to be invited', 'onhold', 'invited', 'confirmed', 'declined', 'unconfirmed', 'Not sent'] as const;
const COLOR_TAGS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;
/** Rows Liquid renders before the browser appends the rest from embedded JSON. */
const ALL_GUESTS_INITIAL_RENDER = 100;

export async function handleCheckinAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  segments: string[],
  url: URL,
  jsonOnly: boolean,
  access: CheckinAccess,
  eventsPluginSecret?: string,
): Promise<Response> {
  const section = segments[0] || 'dashboard';

  if (section === 'dashboard') return dashboard(cms, views, jsonOnly);

  if (section === 'events') {
    const eventId = pageId(segments[1]);
    if (!eventId) return notFoundView(views, 'Event not found.', jsonOnly);
    if (segments[2] === 'all-guests') {
      return eventAllGuests(cms, views, eventId, url, jsonOnly);
    }
    if (segments[2] === 'lists') {
      const listId = pageId(segments[3]);
      if (!listId) return notFoundView(views, 'Guest list not found.', jsonOnly);
      return guestListDetails(cms, views, eventId, listId, url, jsonOnly);
    }
    return eventDashboard(cms, views, eventId, jsonOnly, access);
  }

  if (section === 'kiosk') {
    return handleKioskAdmin(cms, views, segments.slice(1), url, request, jsonOnly, access, eventsPluginSecret);
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
  if (activeEvents.length === 1) return redirect(`${ADMIN_BASE}/events/${activeEvents[0].id}`);
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

  // Match cms-plugin-events' admin-controlled list order exactly.
  const lists = (await listByEvent(cms, 'mail_list', eventId)).sort(compareByWeightThenName);
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
    allGuestsHref: `${ADMIN_BASE}/events/${event.id}/all-guests`,
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
      detailHref: `${ADMIN_BASE}/events/${event.id}/lists/${list.id}`,
      searchHref: `${ADMIN_BASE}/rsvp/${list.id}/guests/search`,
      checkedIn: s.checked_in_count,
      total: s.guest_count,
      checkedInHeadcount: s.checked_in_total,
      totalHeadcount: s.guest_total,
    })),
    activity,
  }, jsonOnly);
}

/** Check-in-owned roll call across every guest list on one event. */
async function eventAllGuests(cms: CmsClient, views: Fetcher, eventId: number, url: URL, jsonOnly: boolean): Promise<Response> {
  const event = await cms.get(eventId).catch(() => null);
  if (!event || event.page_type !== 'event') return notFoundView(views, 'Event not found.', jsonOnly);

  const lists = (await listByEvent(cms, 'mail_list', event.id)).sort(compareByWeightThenName);
  const customFields = eventCustomFields(event, lists);
  const requestedField = url.searchParams.get('cf')?.trim() ?? '';
  const selectedCustomField = customFields.find((field) => field.key === requestedField || field.legacyKey === requestedField) ?? null;
  const detailHref = `${ADMIN_BASE}/events/${event.id}/all-guests`;
  const returnTo = selectedCustomField ? `${detailHref}?cf=${encodeURIComponent(selectedCustomField.key)}` : detailHref;
  const listGuests = await Promise.all(lists.map(async (list) => ({
    list,
    pages: (await cms.list('guest', { pointer: { key: 'mail_list', value: list.id }, limit: 500 })).pages,
  })));
  const guests = listGuests
    .flatMap(({ list, pages }) => pages.map((guest) => ({
      id: guest.id,
      name: guest.name,
      listName: list.name,
      organization: attr(guest.lect, 'organization'),
      email: attr(guest.lect, 'email'),
      status: attr(guest.lect, 'status') || 'Not sent',
      colorTag: attr(guest.lect, 'color_tag'),
      customFieldValue: selectedCustomField ? guestCustomFieldValue(guest, selectedCustomField) : '',
      searchText: chineseSearchText([
        guest.name,
        guest.id,
        list.name,
        attr(guest.lect, 'email'),
        attr(guest.lect, 'phone'),
        attr(guest.lect, 'organization'),
        attr(guest.lect, 'status'),
        selectedCustomField ? guestCustomFieldValue(guest, selectedCustomField) : '',
      ].join(' ')),
      plusGuests: plusGuestsCap(guest),
      checkedIn: mainCheckinCount(guest) > 0,
      guestHref: `${KIOSK_BASE}/${event.id}/guests/${guest.id}?return_to=${encodeURIComponent(returnTo)}`,
    })))
    .sort((a, b) => a.name.localeCompare(b.name));
  const initialGuests = jsonOnly ? guests : guests.slice(0, ALL_GUESTS_INITIAL_RENDER);
  const deferredGuests = jsonOnly ? [] : guests.slice(ALL_GUESTS_INITIAL_RENDER);

  return adminView(views, `All guests — ${event.name}`, 'all-guests', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${event.id}`,
    detailHref,
    scanHref: `${KIOSK_BASE}/${event.id}/scan`,
    settingsHref: `${KIOSK_BASE}/${event.id}/settings`,
    statuses: GUEST_STATUSES,
    colorOptions: COLOR_TAGS.map((value) => ({ value, label: value })),
    hasCustomFields: customFields.length > 0,
    customFields: customFields.map((field) => ({ key: field.key, label: field.label, selected: field.key === selectedCustomField?.key })),
    selectedCustomFieldKey: selectedCustomField?.key ?? '',
    totalCount: guests.length,
    filteredCount: guests.length,
    initialCount: initialGuests.length,
    guests: initialGuests,
    hasGuests: guests.length > 0,
    asyncGuests: deferredGuests.length > 0,
    deferredGuestCount: deferredGuests.length,
    deferredGuestsJson: scriptSafeJson(deferredGuests),
  }, jsonOnly);
}

/** JSON embedded in HTML must remain inert instead of creating markup. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Legacy guest-list-details parity: one event-scoped list and all its guests. */
async function guestListDetails(cms: CmsClient, views: Fetcher, eventId: number, listId: number, url: URL, jsonOnly: boolean): Promise<Response> {
  const [event, list] = await Promise.all([
    cms.get(eventId).catch(() => null),
    cms.get(listId).catch(() => null),
  ]);
  if (!event || event.page_type !== 'event' || !list || list.page_type !== 'mail_list' || pointer(list.lect, 'event') !== String(eventId)) {
    return notFoundView(views, 'Guest list not found.', jsonOnly);
  }

  const detailHref = `${ADMIN_BASE}/events/${event.id}/lists/${list.id}`;
  const customFields = eventCustomFields(event, [list]);
  const requestedField = url.searchParams.get('cf')?.trim() ?? '';
  const selectedCustomField = customFields.find((field) => field.key === requestedField || field.legacyKey === requestedField) ?? null;
  const { pages } = await cms.list('guest', { pointer: { key: 'mail_list', value: list.id }, limit: 500 });
  const guests = pages
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((guest) => ({
      id: guest.id,
      name: guest.name,
      organization: attr(guest.lect, 'organization'),
      email: attr(guest.lect, 'email'),
      status: attr(guest.lect, 'status') || 'Not sent',
      colorTag: attr(guest.lect, 'color_tag'),
      customFieldValue: selectedCustomField ? guestCustomFieldValue(guest, selectedCustomField) : '',
      searchText: chineseSearchText([
        guest.name,
        attr(guest.lect, 'email'),
        attr(guest.lect, 'organization'),
        attr(guest.lect, 'status'),
        selectedCustomField ? guestCustomFieldValue(guest, selectedCustomField) : '',
      ].join(' ')),
      plusGuests: plusGuestsCap(guest),
      checkedIn: mainCheckinCount(guest) > 0,
      guestHref: `${KIOSK_BASE}/${event.id}/guests/${guest.id}?return_to=${encodeURIComponent(detailHref)}`,
    }));

  return adminView(views, `${list.name} — ${event.name}`, 'guest-list-details', {
    eventName: event.name,
    listName: list.name,
    backHref: `${ADMIN_BASE}/events/${event.id}`,
    detailHref,
    scanHref: `${KIOSK_BASE}/${event.id}/scan`,
    settingsHref: `${KIOSK_BASE}/${event.id}/settings`,
    statuses: GUEST_STATUSES,
    colorOptions: COLOR_TAGS.map((value) => ({ value, label: value })),
    hasCustomFields: customFields.length > 0,
    customFields: customFields.map((field) => ({ key: field.key, label: field.label, selected: field.key === selectedCustomField?.key })),
    selectedCustomFieldKey: selectedCustomField?.key ?? '',
    guests,
    hasGuests: guests.length > 0,
  }, jsonOnly);
}

async function guestSearch(cms: CmsClient, views: Fetcher, listId: number, url: URL, jsonOnly: boolean): Promise<Response> {
  const list = await cms.get(listId);
  if (list.page_type !== 'mail_list') return notFoundView(views, 'Guest list not found.', jsonOnly);
  const q = url.searchParams.get('q')?.trim() ?? '';
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
  eventsPluginSecret?: string,
): Promise<Response> {
  const eventId = pageId(segments[0]);
  if (!eventId) return notFoundView(views, 'Event not found.', jsonOnly);

  const event = await cms.get(eventId).catch(() => null);
  if (!event || event.page_type !== 'event') return notFoundView(views, 'Event not found.', jsonOnly);

  const sub = segments[1];
  if (!sub || sub === 'scan') return kioskScan(cms, views, event, request, jsonOnly, access, eventsPluginSecret);
  if (sub === 'search') return kioskSearch(cms, views, event, url, jsonOnly);
  if (sub === 'settings') return kioskView(views, `Settings — ${event.name}`, 'kiosk-settings', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${event.id}`,
  }, jsonOnly);
  if (sub === 'adhoc-guest') {
    if (!access.canCheckIn) return forbidden();
    return kioskAdhocGuest(cms, views, event, request, jsonOnly);
  }
  if (sub === 'guests') return kioskGuest(cms, views, event, segments.slice(2), url, request, jsonOnly, access);

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

async function kioskScan(
  cms: CmsClient,
  views: Fetcher,
  event: CmsPage,
  request: Request,
  jsonOnly: boolean,
  access: CheckinAccess,
  eventsPluginSecret?: string,
): Promise<Response> {
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
    const guest = code ? await findGuestByCodeInEvent(cms, event.id, code, eventsPluginSecret) : null;
    if (guest) return redirect(`${KIOSK_BASE}/${event.id}/guests/${guest.id}`);
    return kioskView(views, event.name, 'kiosk-scan', { ...data, error: 'No guest found for that code.' }, jsonOnly, { camera: true });
  }
  return kioskView(views, event.name, 'kiosk-scan', data, jsonOnly, { camera: true });
}

async function kioskSearch(cms: CmsClient, views: Fetcher, event: CmsPage, url: URL, jsonOnly: boolean): Promise<Response> {
  const q = url.searchParams.get('q')?.trim() ?? '';
  // `field` selects a custom-field search (match that field's value) instead of
  // the default name/email/organization/phone search.
  const fieldParam = url.searchParams.get('field')?.trim() ?? '';
  const lists = q ? await listByEvent(cms, 'mail_list', event.id) : [];
  const listById = new Map(lists.map((list) => [list.id, list]));
  const customField = fieldParam
    ? eventCustomFields(event, lists).find((field) => field.key === fieldParam || field.legacyKey === fieldParam) ?? null
    : null;
  const matches = q ? await searchGuestsInEvent(cms, listById, q) : [];
  const filteredMatches = customField ? filterGuestsByCustomField(matches, customField, q) : matches;

  const guests: Array<{ id: number; name: string; organization: string; listName: string; checkedIn: boolean; guestHref: string }> = [];
  for (const guest of filteredMatches) {
    const listId = guestListId(guest);
    const list = listId ? listById.get(listId) : null;
    if (!list) continue;
    guests.push({
      id: guest.id,
      name: guest.name,
      organization: attr(guest.lect, 'organization'),
      listName: list.name,
      checkedIn: mainCheckinCount(guest) > 0,
      guestHref: `${KIOSK_BASE}/${event.id}/guests/${guest.id}`,
    });
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

async function searchGuestsInEvent(cms: CmsClient, listById: Map<number, CmsPage>, q: string): Promise<CmsPage[]> {
  if (listById.size === 0) return [];
  const query = q.trim();
  if (!query) return [];
  const { pages } = await cms.listByPointerValues('guest', 'mail_list', [...listById.keys()], { q: query, limit: 500 });
  return pages;
}

function guestListId(guest: CmsPage): number | null {
  return pageId(guest.page_id) ?? pageId(pointer(guest.lect, 'mail_list'));
}

/** Guests whose custom-field value contains `q` (case-insensitive). */
function filterGuestsByCustomField(guests: CmsPage[], field: CustomField, q: string): CmsPage[] {
  const query = q.trim();
  const needle = query.toLowerCase();
  return guests.filter((guest) => {
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

async function kioskGuest(cms: CmsClient, views: Fetcher, event: CmsPage, rest: string[], url: URL, request: Request, jsonOnly: boolean, access: CheckinAccess): Promise<Response> {
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
  const returnTo = safeAdminReturn(url.searchParams.get('return_to'));

  if (action === 'badge') return renderBadge(cms, event, guest);

  if (action && request.method === 'POST') {
    if (!access.canCheckIn) return forbidden();
    guest = await performGuestAction(cms, guest, event, action, request);
    return redirect(`${KIOSK_BASE}/${event.id}/guests/${guest.id}${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`);
  }

  return renderKioskGuest(cms, views, event, list, guest, jsonOnly, access, returnTo);
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
    if (!eventRfidEnabled(event)) return guest;
    const tag = String(form?.get('tag') ?? '').trim();
    if (tag) return saveRfid(cms, guest, tag);
    return guest;
  }
  return guest;
}

async function renderKioskGuest(cms: CmsClient, views: Fetcher, event: CmsPage, list: CmsPage, guest: CmsPage, jsonOnly: boolean, access: CheckinAccess, returnTo = ''): Promise<Response> {
  const cap = plusGuestsCap(guest);
  const plusGuests = Array.from({ length: cap }, (_, index) => ({
    index,
    label: `Plus guest ${index + 1}`,
    checkedIn: plusCheckinCount(guest, index) > 0,
  }));
  const sessions = checkinSessions(event).map((session) => ({ ...session, checkedIn: sessionCheckinCount(guest, session.id) > 0 }));
  const actionBase = `${KIOSK_BASE}/${event.id}/guests/${guest.id}`;
  // Badge previews are additive to check-in; an unavailable labels endpoint
  // must not prevent door staff from opening a guest record.
  const labels = await eventLabels(cms, event.id).catch(() => []);
  const tokens = guestTokens(guest, list, event);

  return kioskView(views, guest.name, 'kiosk-guest', {
    eventId: event.id,
    eventName: event.name,
    guestId: guest.id,
    guestName: guest.name,
    // Guest photo (the legacy attendee-details screen showed one). The guest
    // `picture` attr is an absolute URL or a CMS media path; the kiosk renders
    // under the CMS admin proxy, so root-relative paths resolve correctly.
    picture: attr(guest.lect, 'picture'),
    organization: attr(guest.lect, 'organization'),
    email: attr(guest.lect, 'email'),
    canCheckIn: access.canCheckIn,
    mainCheckedIn: mainCheckinCount(guest) > 0,
    mainAtCap: mainCheckinCount(guest) >= maxMainCheckins(guest),
    plusGuests,
    hasPlusGuests: plusGuests.length > 0,
    sessions,
    hasSessions: sessions.length > 0,
    hasRfid: eventRfidEnabled(event),
    rfid: attr(guest.lect, 'barcode'),
    actionBase,
    backHref: returnTo || `${KIOSK_BASE}/${event.id}/scan`,
    labels: labels.map((label) => ({ name: label.name, design: labelDesign(label) })),
    hasLabels: labels.length > 0,
    labelTokens: JSON.stringify(tokens),
    settingsHref: `${KIOSK_BASE}/${event.id}/settings`,
  }, jsonOnly);
}

/** RFID pairing is opt-in per event in the Events plugin's event attributes. */
function eventRfidEnabled(event: CmsPage): boolean {
  return attr(event.lect, 'rfid').trim().toLowerCase() === 'yes';
}

async function renderBadge(cms: CmsClient, event: CmsPage, guest: CmsPage): Promise<Response> {
  const labels = await eventLabels(cms, event.id);
  if (!labels.length) return new Response('No badge template configured for this event yet.', { status: 404 });
  const frame = labelFrame(labels[0]);
  const svg = renderLabel(frame.svg, guestTokens(guest));
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } });
}

/** Scans every guest list on the event, in order, for a guest whose qrcode/barcode matches. */
async function findGuestByCodeInEvent(
  cms: CmsClient,
  eventId: number,
  code: string,
  eventsPluginSecret?: string,
): Promise<CmsPage | null> {
  const lists = await listByEvent(cms, 'mail_list', eventId);
  const signed = await resolveCheckinCode(code, eventsPluginSecret);
  if (signed) {
    const list = lists.find((candidate) => candidate.id === signed.listId);
    if (!list) return null; // A valid code for another event must not escape this kiosk.
    const guest = await cms.get(signed.guestId).catch(() => null);
    if (guest?.page_type === 'guest' && guest.page_id === list.id) return guest;
    return null;
  }

  // Legacy RFID/barcode and manually-paired QR values remain list-scoped.
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
