// Core check-in domain logic. The `guest.checkin` block only has
// `@status @date @message` (cms-plugin-events blueprint) — no dedicated
// fields for "which plus guest" or "which session" — so structured check-in
// events are encoded into a parseable `message` string (see the format*/
// parseCheckinEntry pair below) instead of changing that plugin's blueprint.
//
// Every write is a full read-modify-write of the `checkin` array: the CMS
// replaces `lect` keys wholesale on update (confirmed by
// cms-plugin-events/src/rsvp.ts checkInGuest), so there is no server-side
// append.

import { attr, checkins, items, localized, type CmsClient, type CmsPage } from './cms';

export type CheckinVia = 'kiosk' | 'qr';

export type ParsedCheckin =
  | { kind: 'main' }
  | { kind: 'plus'; index: number; name?: string }
  | { kind: 'session'; sessionId: string; sessionName: string };

export interface CheckinRecord {
  status: string;
  date: string;
  message: string;
}

const SESSION_RE = /^session (\S+) "(.*)" checked-in/;
const PLUS_RE = /^plus guest (\d+)(?: \("(.*)"\))? checked-in/;

/** Builds the `message` string for a main-attendee check-in. */
export function formatMainMessage(via: CheckinVia): string {
  return via === 'qr' ? 'main attendee checked-in via QR' : 'main attendee checked-in from kiosk';
}

/** Builds the `message` string for a plus guest check-in. `index` is 0-based, matching the QR link's `index` segment. */
export function formatPlusMessage(index: number, via: CheckinVia, name?: string): string {
  const label = name ? `plus guest ${index + 1} ("${name}")` : `plus guest ${index + 1}`;
  return via === 'qr' ? `${label} checked-in via QR` : `${label} checked-in from kiosk`;
}

/** Builds the `message` string for a session check-in. */
export function formatSessionMessage(sessionId: string, sessionName: string): string {
  return `session ${sessionId} "${sessionName}" checked-in from kiosk`;
}

/**
 * Recovers the structured shape of a `checkin[].message`. Anything that
 * doesn't match the plus/session formats — including the admin route's
 * plain `"checked in by event admin"` and any other historical message —
 * is treated as a main-attendee check-in, matching how
 * `computeGuestListSummary`/`checkins().length > 0` already treat any entry
 * as "checked in" regardless of message content.
 */
export function parseCheckinEntry(message: string): ParsedCheckin {
  const session = SESSION_RE.exec(message);
  if (session) return { kind: 'session', sessionId: session[1], sessionName: session[2] };

  const plus = PLUS_RE.exec(message);
  if (plus) return { kind: 'plus', index: Number.parseInt(plus[1], 10) - 1, name: plus[2] || undefined };

  return { kind: 'main' };
}

/** Max main-attendee check-ins allowed. Blank/zero/invalid defaults to 1. */
export function maxMainCheckins(guest: CmsPage): number {
  const raw = Number.parseInt(attr(guest.lect, 'max_main_checkin'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Number of plus guests this guest is allowed to bring. */
export function plusGuestsCap(guest: CmsPage): number {
  const raw = Number.parseInt(attr(guest.lect, 'plus_guests'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function mainCheckinCount(guest: CmsPage): number {
  return checkins(guest.lect).filter((entry) => parseCheckinEntry(String(entry.message ?? '')).kind === 'main').length;
}

export function plusCheckinCount(guest: CmsPage, index: number): number {
  return checkins(guest.lect).filter((entry) => {
    const parsed = parseCheckinEntry(String(entry.message ?? ''));
    return parsed.kind === 'plus' && parsed.index === index;
  }).length;
}

export function sessionCheckinCount(guest: CmsPage, sessionId: string): number {
  return checkins(guest.lect).filter((entry) => {
    const parsed = parseCheckinEntry(String(entry.message ?? ''));
    return parsed.kind === 'session' && parsed.sessionId === sessionId;
  }).length;
}

/** Appends one check-in entry and persists the guest. */
export async function recordCheckin(cms: CmsClient, guest: CmsPage, message: string): Promise<CmsPage> {
  const entry: CheckinRecord = { status: 'checked-in', date: new Date().toISOString(), message };
  return cms.update(guest.id, { lect: { checkin: [...checkins(guest.lect), entry] } });
}

/**
 * Removes the most recent check-in entry matching `predicate` (mirrors the
 * legacy app's per-kind undo, e.g. "undo last main attendee check-in"). A
 * no-op (guest returned unchanged, `removed: false`) if nothing matches.
 */
export async function undoCheckin(cms: CmsClient, guest: CmsPage, predicate: (parsed: ParsedCheckin) => boolean): Promise<{ guest: CmsPage; removed: boolean }> {
  const existing = checkins(guest.lect);
  let removeAt = -1;
  for (let i = existing.length - 1; i >= 0; i -= 1) {
    if (predicate(parseCheckinEntry(String(existing[i].message ?? '')))) {
      removeAt = i;
      break;
    }
  }
  if (removeAt === -1) return { guest, removed: false };

  const next = [...existing.slice(0, removeAt), ...existing.slice(removeAt + 1)];
  const updated = await cms.update(guest.id, { lect: { checkin: next } });
  return { guest: updated, removed: true };
}

/** Clears every check-in entry for a guest (legacy "undo all"). */
export async function undoAllCheckins(cms: CmsClient, guest: CmsPage): Promise<CmsPage> {
  return cms.update(guest.id, { lect: { checkin: [] } });
}

/**
 * Resolves a scanned code against a guest list's `qrcode`/`barcode`
 * attributes — the same dual-attribute match the legacy app used for
 * non-native (external/RFID) codes. RFID has no dedicated storage field in
 * the guest blueprint, so a saved RFID tag is also stored in `barcode`.
 */
export async function findGuestByCode(cms: CmsClient, listId: number, code: string): Promise<CmsPage | null> {
  const target = code.trim();
  if (!target) return null;
  const { pages } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, limit: 500 });
  return pages.find((guest) => attr(guest.lect, 'qrcode') === target || attr(guest.lect, 'barcode') === target) ?? null;
}

/** Saves a scanned RFID tag onto a guest, reusing the `barcode` field (see findGuestByCode). */
export async function saveRfid(cms: CmsClient, guest: CmsPage, tag: string): Promise<CmsPage> {
  return cms.update(guest.id, { lect: { barcode: tag.trim() } });
}

/** Free-text search over one guest list, delegated to Worker CMS' `q` search. */
export async function searchGuests(cms: CmsClient, listId: number, query: string): Promise<CmsPage[]> {
  const q = query.trim();
  const { pages } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, q, limit: 500 });
  return pages;
}

export interface WalkInInput {
  name: string;
  email?: string;
  phone?: string;
  organization?: string;
  plusGuests?: number;
}

export interface CheckinSession {
  id: string;
  name: string;
}

/**
 * Sessions with check-in enabled (`@checkin:switch`). A session's id is its
 * stable array index within `event.lect.session` — cms-plugin-events itself
 * uses that same index as the identity key for reordering (`_weight` is
 * written onto rows in place rather than physically reordering them), so the
 * index survives reorders.
 */
export function checkinSessions(event: CmsPage): CheckinSession[] {
  return items(event.lect, 'session')
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => attr(session, 'checkin') === 'yes')
    .map(({ session, index }) => ({ id: String(index), name: localized(session, 'name') || `Session ${index + 1}` }));
}

/** Creates a walk-in guest directly in the currently-unlocked kiosk list. */
export async function createWalkInGuest(cms: CmsClient, listId: number, input: WalkInInput): Promise<CmsPage> {
  return cms.create({
    page_type: 'guest',
    page_id: listId,
    name: input.name,
    lect: {
      _pointers: { mail_list: String(listId) },
      email: input.email ?? '',
      phone: input.phone ?? '',
      organization: input.organization ?? '',
      plus_guests: String(input.plusGuests ?? 0),
      status: 'confirmed',
    },
  });
}
