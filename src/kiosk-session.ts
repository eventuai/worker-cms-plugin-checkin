// Passcode-lite kiosk auth. A door/kiosk device unlocks one guest list by
// submitting that list's `checkin_lite_passcode` (cms-plugin-events
// mail_list blueprint field), and gets back a short-lived signed cookie
// scoped to that list — no CMS login needed at the door. Full CMS-session
// admin routes are gated separately, in permissions.ts.

import { signPayload, verifyPayload } from './crypto';

const TTL_SECONDS = 12 * 60 * 60; // 12h — long enough for one shift, short enough to force re-entry daily.

function cookieName(listId: number): string {
  return `checkin_kiosk_${listId}`;
}

/** Builds the Set-Cookie header value that unlocks kiosk access to one list. */
export async function mintKioskCookie(secret: string, listId: number, ttlSeconds = TTL_SECONDS): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = `${listId}.${expires}`;
  const sig = await signPayload(secret, token);
  const value = `${token}.${sig}`;
  return `${cookieName(listId)}=${value}; Path=/kiosk/${listId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

/** True if the request carries a valid, unexpired kiosk cookie for this list. */
export async function hasKioskSession(request: Request, secret: string, listId: number): Promise<boolean> {
  const cookie = readCookie(request, cookieName(listId));
  if (!cookie) return false;

  const parts = cookie.split('.');
  if (parts.length !== 3) return false;
  const [listPart, expiryPart, sig] = parts;
  if (listPart !== String(listId)) return false;

  const expires = Number.parseInt(expiryPart, 10);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;

  return verifyPayload(secret, `${listPart}.${expiryPart}`, sig);
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
