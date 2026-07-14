// Verifies the direct check-in QR links cms-plugin-events already mints
// (src/rsvp.ts guestQr/plusGuestQrCodes): {PUBLIC_BASE_URL}/checkin/{listId}/{guestId}/{sig}
// for the main attendee, and .../{listId}/{guestId}/{index}/{sig} for a
// specific plus guest. Signed with that plugin's own PLUGIN_SECRET, so this
// plugin verifies against a copy of it (env.EVENTS_PLUGIN_SECRET) — see
// wrangler.toml for the deployment note on why a copy is needed instead of a
// shared binding.

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { verifyPayload } from './crypto';

export type CheckinLink =
  | { kind: 'main'; listId: number; guestId: number }
  | { kind: 'plus'; listId: number; guestId: number; index: number };

/**
 * Parses the path segments after `/checkin/` and verifies the trailing
 * signature. Returns null for a malformed path or a bad signature — callers
 * should treat both as "not found" so a tampered link can't distinguish the
 * two failure modes.
 */
export async function resolveCheckinLink(segments: string[], secret: string | undefined): Promise<CheckinLink | null> {
  if (!secret) return null;

  if (segments.length === 3) {
    const [listRaw, guestRaw, sig] = segments;
    const listId = pageId([listRaw]);
    const guestId = pageId([guestRaw]);
    if (!listId || !guestId || !sig) return null;
    const payload = `${listId}.${guestId}`;
    if (!(await verifyPayload(secret, payload, sig))) return null;
    return { kind: 'main', listId, guestId };
  }

  if (segments.length === 4) {
    const [listRaw, guestRaw, indexRaw, sig] = segments;
    const listId = pageId([listRaw]);
    const guestId = pageId([guestRaw]);
    const index = Number.parseInt(indexRaw, 10);
    if (!listId || !guestId || !Number.isInteger(index) || index < 0 || !sig) return null;
    const payload = `${listId}.${guestId}.${index}`;
    if (!(await verifyPayload(secret, payload, sig))) return null;
    return { kind: 'plus', listId, guestId, index };
  }

  return null;
}

/**
 * Resolves the values a door scanner actually returns. Besides a direct
 * `/checkin/...` path, cameras commonly return the complete absolute URL;
 * older printed badges use the compact `list.guest.signature` token. All
 * forms converge on the same signature verifier above.
 */
export async function resolveCheckinCode(code: string, secret: string | undefined): Promise<CheckinLink | null> {
  const value = code.trim();
  if (!value) return null;

  // The Events plugin renders these compact QR payloads for printed guest
  // tickets. They intentionally use a short BLAKE3 checksum rather than the
  // Events plugin secret, so resolve them before trying URL/token forms.
  const compact = resolveCompactCheckinCode(value);
  if (compact) return compact;

  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments[0] === 'checkin' ? resolveCheckinLink(segments.slice(1), secret) : null;
  } catch {
    // Not an absolute URL — continue with direct paths and compact tokens.
  }

  const pathSegments = value.split('?')[0].split('/').filter(Boolean);
  if (pathSegments[0] === 'checkin') return resolveCheckinLink(pathSegments.slice(1), secret);

  const tokenSegments = value.split('.').filter(Boolean);
  return resolveCheckinLink(tokenSegments, secret);
}

/**
 * Resolves the compact QR payload emitted by cms-plugin-events:
 * `EAI{list-base32}:{guest-id-minus-list-base32}:{M|plus-index}:{checksum}`.
 * This is also the legacy Eventuai ticket format, retained by Events so
 * printed tickets remain small and compatible with existing scanners.
 */
function resolveCompactCheckinCode(value: string): CheckinLink | null {
  const match = /^EAI([0-9a-v]+):([0-9a-v]+):(M|[0-9]+):([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;

  const [, listRaw, guestDeltaRaw, markerRaw, signature] = match;
  const listId = parseBase32Id(listRaw);
  const guestDelta = parseBase32Id(guestDeltaRaw);
  if (!listId || guestDelta === null) return null;
  const guestId = listId + guestDelta;
  if (!Number.isSafeInteger(guestId) || guestId <= 0) return null;

  const marker = markerRaw.toUpperCase();
  const plusIndex = marker === 'M' ? undefined : Number(marker);
  if (plusIndex !== undefined && (!Number.isSafeInteger(plusIndex) || plusIndex < 0)) return null;

  const signedValue = `qrcode${listId}${guestId}${plusIndex ?? ''}`;
  const expected = bytesToHex(blake3(new TextEncoder().encode(signedValue))).slice(0, 6);
  if (signature.toLowerCase() !== expected) return null;

  return plusIndex === undefined
    ? { kind: 'main', listId, guestId }
    : { kind: 'plus', listId, guestId, index: plusIndex };
}

function parseBase32Id(value: string): number | null {
  if (!/^[0-9a-v]+$/i.test(value)) return null;
  const id = Number.parseInt(value, 32);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

function pageId(parts: string[]): number | null {
  const id = Number(parts[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}
