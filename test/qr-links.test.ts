import { describe, expect, it } from 'vitest';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { signPayload } from '../src/crypto';
import { compactCheckinCode, resolveCheckinCode, resolveCheckinLink } from '../src/qr-links';

const SECRET = 'events-plugin-secret';

describe('resolveCheckinLink', () => {
  it('resolves a main-attendee link matching cms-plugin-events\' token shape', async () => {
    const sig = await signPayload(SECRET, '12.34');
    const link = await resolveCheckinLink(['12', '34', sig], SECRET);
    expect(link).toEqual({ kind: 'main', listId: 12, guestId: 34 });
  });

  it('resolves a plus-guest link', async () => {
    const sig = await signPayload(SECRET, '12.34.0');
    const link = await resolveCheckinLink(['12', '34', '0', sig], SECRET);
    expect(link).toEqual({ kind: 'plus', listId: 12, guestId: 34, index: 0 });
  });

  it('rejects a tampered signature', async () => {
    const sig = await signPayload(SECRET, '12.34');
    expect(await resolveCheckinLink(['12', '99', sig], SECRET)).toBeNull();
  });

  it('rejects a signature made with a different secret', async () => {
    const sig = await signPayload('wrong-secret', '12.34');
    expect(await resolveCheckinLink(['12', '34', sig], SECRET)).toBeNull();
  });

  it('rejects malformed paths', async () => {
    expect(await resolveCheckinLink(['12'], SECRET)).toBeNull();
    expect(await resolveCheckinLink(['12', '34', '5', '6', '7'], SECRET)).toBeNull();
  });

  it('rejects when no secret is configured', async () => {
    const sig = await signPayload(SECRET, '12.34');
    expect(await resolveCheckinLink(['12', '34', sig], undefined)).toBeNull();
  });

  it('resolves raw QR tokens and absolute QR links from a scanner', async () => {
    const sig = await signPayload(SECRET, '12.34');
    expect(await resolveCheckinCode(`12.34.${sig}`, SECRET)).toEqual({ kind: 'main', listId: 12, guestId: 34 });
    expect(await resolveCheckinCode(`https://checkin.example/checkin/12/34/${sig}?t=tenant-a`, SECRET))
      .toEqual({ kind: 'main', listId: 12, guestId: 34 });
  });

  it('resolves the compact EAI payload rendered by cms-plugin-events', async () => {
    const listId = 21996952637102;
    const guestId = 22011127818988;
    const signature = bytesToHex(blake3(new TextEncoder().encode(`qrcode${listId}${guestId}`))).slice(0, 6);
    const code = `EAI${listId.toString(32)}:${(guestId - listId).toString(32)}:M:${signature}`;

    expect(await resolveCheckinCode(code, undefined)).toEqual({ kind: 'main', listId, guestId });
  });

  it('rejects a compact EAI payload with an invalid checksum', async () => {
    expect(await resolveCheckinCode('EAI34:p:M:000000', undefined)).toBeNull();
  });

  it('mints a compact code that resolves back to the same guest', async () => {
    const listId = 22035211676826;
    const guestId = 22035933209321;
    const code = compactCheckinCode(listId, guestId);

    expect(code).toMatch(/^EAI[0-9a-v]+:[0-9a-v]+:M:[0-9a-f]{6}$/);
    expect(await resolveCheckinCode(code, undefined)).toEqual({ kind: 'main', listId, guestId });
  });

  it('supports guest ids lower than the list id', async () => {
    const listId = 22035274339672;
    const guestId = 1780933209321;
    const code = compactCheckinCode(listId, guestId);

    expect(code).toMatch(/^EAI[0-9-a-v]+:-[0-9-a-v]+:M:[0-9a-f]{6}$/);
    expect(await resolveCheckinCode(code, undefined)).toEqual({ kind: 'main', listId, guestId });
  });

  it('refuses to mint a compact code outside the legacy id scheme', () => {
    expect(() => compactCheckinCode(0, 34)).toThrow();
    expect(() => compactCheckinCode(12, 0)).toThrow();
  });
});
