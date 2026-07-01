import { describe, expect, it } from 'vitest';
import { hasKioskSession, mintKioskCookie } from '../src/kiosk-session';

const SECRET = 'plugin-secret';

function requestWithCookie(cookie: string): Request {
  return new Request('https://checkin.test/kiosk/12/scan', { headers: { cookie } });
}

describe('kiosk session cookie', () => {
  it('accepts a freshly minted cookie for the same list', async () => {
    const setCookie = await mintKioskCookie(SECRET, 12);
    const cookieValue = setCookie.split(';')[0];
    expect(await hasKioskSession(requestWithCookie(cookieValue), SECRET, 12)).toBe(true);
  });

  it('rejects a cookie minted for a different list', async () => {
    const setCookie = await mintKioskCookie(SECRET, 12);
    const cookieValue = setCookie.split(';')[0].replace('checkin_kiosk_12', 'checkin_kiosk_99');
    expect(await hasKioskSession(requestWithCookie(cookieValue), SECRET, 99)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const setCookie = await mintKioskCookie(SECRET, 12);
    const [name, value] = setCookie.split(';')[0].split('=');
    const [listId, expiry] = value.split('.');
    const tampered = `${name}=${listId}.${expiry}.deadbeef`;
    expect(await hasKioskSession(requestWithCookie(tampered), SECRET, 12)).toBe(false);
  });

  it('rejects an expired cookie', async () => {
    const setCookie = await mintKioskCookie(SECRET, 12, -1);
    const cookieValue = setCookie.split(';')[0];
    expect(await hasKioskSession(requestWithCookie(cookieValue), SECRET, 12)).toBe(false);
  });

  it('rejects when there is no cookie at all', async () => {
    expect(await hasKioskSession(new Request('https://checkin.test/kiosk/12/scan'), SECRET, 12)).toBe(false);
  });
});
