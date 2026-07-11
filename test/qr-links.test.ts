import { describe, expect, it } from 'vitest';
import { signPayload } from '../src/crypto';
import { resolveCheckinCode, resolveCheckinLink } from '../src/qr-links';

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
});
