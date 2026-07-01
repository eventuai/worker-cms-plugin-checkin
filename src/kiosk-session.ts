// Passcode-lite kiosk auth. A door/kiosk device unlocks one event by
// submitting that event's `checkin_lite_passcode` (cms-plugin-events event
// blueprint field), and gets back a short-lived signed cookie scoped to that
// event — no CMS login needed at the door. Full CMS-session admin routes are
// gated separately, in permissions.ts.

import { signPayload, verifyPayload } from './crypto';

const TTL_SECONDS = 12 * 60 * 60; // 12h — long enough for one shift, short enough to force re-entry daily.
const LAUNCH_TTL_SECONDS = 5 * 60; // 5 min — enough to load the page and click; prevents URL-sharing attacks.

function cookieName(eventId: number): string {
  return `checkin_kiosk_${eventId}`;
}

/** Builds the Set-Cookie header value that unlocks kiosk access to one event. */
export async function mintKioskCookie(secret: string, eventId: number, ttlSeconds = TTL_SECONDS): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = `${eventId}.${expires}`;
  const sig = await signPayload(secret, token);
  const value = `${token}.${sig}`;
  return `${cookieName(eventId)}=${value}; Path=/kiosk/${eventId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

/** True if the request carries a valid, unexpired kiosk cookie for this event. */
export async function hasKioskSession(request: Request, secret: string, eventId: number): Promise<boolean> {
  const cookie = readCookie(request, cookieName(eventId));
  if (!cookie) return false;

  const parts = cookie.split('.');
  if (parts.length !== 3) return false;
  const [idPart, expiryPart, sig] = parts;
  if (idPart !== String(eventId)) return false;

  const expires = Number.parseInt(expiryPart, 10);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;

  return verifyPayload(secret, `${idPart}.${expiryPart}`, sig);
}

/**
 * Returns a URL query-param-safe token an admin page can embed in a kiosk
 * launch link. The kiosk validates it at /kiosk/{eventId}/launch and mints the
 * full 12h session cookie — bypassing the passcode screen for CMS staff.
 */
export async function mintAdminLaunchToken(secret: string, eventId: number): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + LAUNCH_TTL_SECONDS;
  const payload = `launch.${eventId}.${expires}`;
  const sig = await signPayload(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyAdminLaunchToken(secret: string, token: string, eventId: number): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 4) return false;
  const [kind, idPart, expiryPart, sig] = parts;
  if (kind !== 'launch' || idPart !== String(eventId)) return false;
  const expires = Number.parseInt(expiryPart, 10);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  return verifyPayload(secret, `${kind}.${idPart}.${expiryPart}`, sig);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
