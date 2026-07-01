// CMS-session-gated admin surface: /__plugin/admin/checkin/*. Staff with a
// full CMS login manage check-in from here; the passcode-lite kiosk (public.ts)
// is the door-side surface that doesn't need one.

import { adminView, notFoundView, redirect, type CmsPage } from '@lionrockjs/worker-cms-plugin';
import { attr, checkins, CmsClient, computeGuestListSummary, listByEvent, PLUGIN_ID } from './cms';
import { checkinSessions, mainCheckinCount, plusGuestsCap, recordCheckin, searchGuests, undoCheckin, formatMainMessage } from './checkin-actions';
import { type CheckinAccess } from './permissions';

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
    return eventDashboard(cms, views, eventId, jsonOnly);
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
  return adminView(views, 'Check-in', 'dashboard', {
    events: events.map((event) => ({
      id: event.id,
      name: event.name,
      href: `${ADMIN_BASE}/events/${event.id}`,
      kioskTitle: attr(event.lect, 'kiosk_title') || event.name,
      requiresLogin: attr(event.lect, 'checkin_require_login') === 'yes',
    })),
  }, jsonOnly);
}

async function eventDashboard(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly: boolean): Promise<Response> {
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

  return adminView(views, `Check-in — ${event.name}`, 'event-dashboard', {
    eventName: event.name,
    kioskTitle: attr(event.lect, 'kiosk_title') || event.name,
    sessions: checkinSessions(event),
    lists: listSummaries.map(({ list, summary }) => ({
      id: list.id,
      name: list.name,
      allowCheckin: attr(list.lect, 'allow_checkin') !== 'no',
      showInLite: attr(list.lect, 'show_in_checkin_lite') === 'yes',
      hasPasscode: attr(list.lect, 'checkin_lite_passcode').trim() !== '',
      kioskHref: `/kiosk/${list.id}`,
      searchHref: `${ADMIN_BASE}/rsvp/${list.id}/guests/search`,
      checkedIn: summary.checked_in_count,
      total: summary.guest_count,
      checkedInHeadcount: summary.checked_in_total,
      totalHeadcount: summary.guest_total,
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

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Only honours same-origin `/admin*` return paths, matching cms-plugin-events' guard. */
function safeAdminReturn(value: unknown): string {
  const path = typeof value === 'string' ? value.trim() : '';
  return path.startsWith('/admin') ? path : '';
}
