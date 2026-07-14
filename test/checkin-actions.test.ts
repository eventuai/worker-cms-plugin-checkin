import { afterEach, describe, expect, it, vi } from 'vitest';
import { CmsClient, type CmsPage } from '../src/cms';
import {
  checkinSessions,
  createWalkInGuest,
  findGuestByCode,
  formatMainMessage,
  formatPlusMessage,
  formatSessionMessage,
  mainCheckinCount,
  maxMainCheckins,
  parseCheckinEntry,
  plusCheckinCount,
  plusGuestsCap,
  recordCheckin,
  searchGuests,
  sessionCheckinCount,
  undoCheckin,
} from '../src/checkin-actions';

afterEach(() => {
  vi.unstubAllGlobals();
});

function guest(overrides: Partial<CmsPage> = {}): CmsPage {
  return { id: 1, uuid: 'u1', page_type: 'guest', name: 'Ada Lovelace', slug: 'ada', weight: 0, start: null, end: null, timezone: null, page_id: 12, created_at: '', updated_at: '', lect: {}, ...overrides };
}

describe('parseCheckinEntry', () => {
  it('recognizes a main-attendee entry', () => {
    expect(parseCheckinEntry(formatMainMessage('kiosk'))).toEqual({ kind: 'main' });
  });

  it('recognizes an unnamed plus guest entry and recovers the 0-based index', () => {
    expect(parseCheckinEntry(formatPlusMessage(2, 'kiosk'))).toEqual({ kind: 'plus', index: 2, name: undefined });
  });

  it('recognizes a named plus guest entry', () => {
    expect(parseCheckinEntry(formatPlusMessage(0, 'kiosk', 'Grace Hopper'))).toEqual({ kind: 'plus', index: 0, name: 'Grace Hopper' });
  });

  it('recognizes a session entry', () => {
    expect(parseCheckinEntry(formatSessionMessage('2', 'Opening Keynote'))).toEqual({ kind: 'session', sessionId: '2', sessionName: 'Opening Keynote' });
  });

  it('falls back to main for unrecognized/legacy messages (e.g. the admin route\'s plain message)', () => {
    expect(parseCheckinEntry('checked in by event admin')).toEqual({ kind: 'main' });
  });
});

describe('caps', () => {
  it('defaults max main check-ins to 1 when unset', () => {
    expect(maxMainCheckins(guest())).toBe(1);
  });

  it('honours an explicit max_main_checkin', () => {
    expect(maxMainCheckins(guest({ lect: { max_main_checkin: '3' } }))).toBe(3);
  });

  it('defaults plus guest cap to 0 when unset', () => {
    expect(plusGuestsCap(guest())).toBe(0);
  });
});

describe('counts', () => {
  const withEntries = guest({
    lect: {
      checkin: [
        { status: 'checked-in', date: '2026-01-01T00:00:00Z', message: formatMainMessage('kiosk') },
        { status: 'checked-in', date: '2026-01-01T00:01:00Z', message: formatPlusMessage(0, 'kiosk') },
        { status: 'checked-in', date: '2026-01-01T00:02:00Z', message: formatSessionMessage('2', 'Keynote') },
      ],
    },
  });

  it('counts main check-ins', () => expect(mainCheckinCount(withEntries)).toBe(1));
  it('counts a specific plus guest index', () => {
    expect(plusCheckinCount(withEntries, 0)).toBe(1);
    expect(plusCheckinCount(withEntries, 1)).toBe(0);
  });
  it('counts a specific session', () => {
    expect(sessionCheckinCount(withEntries, '2')).toBe(1);
    expect(sessionCheckinCount(withEntries, '3')).toBe(0);
  });
});

describe('checkinSessions', () => {
  it('lists only sessions with check-in enabled, keyed by array index', () => {
    const event = guest({
      page_type: 'event',
      lect: {
        session: [
          { checkin: 'no', name: 'Prep' },
          { checkin: 'yes', name: 'Opening Keynote' },
          { checkin: 'yes' },
        ],
      },
    });
    expect(checkinSessions(event)).toEqual([
      { id: '1', name: 'Opening Keynote' },
      { id: '2', name: 'Session 3' },
    ]);
  });
});

describe('CMS-backed actions', () => {
  function stubCms(handlers: { get?: () => CmsPage; put?: (body: unknown) => void; list?: (url: URL) => CmsPage[] }) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (init?.method === 'PUT' && handlers.put) {
        const body = JSON.parse(String(init.body));
        handlers.put(body);
        return Response.json({ page: { ...handlers.get?.(), lect: body.lect } });
      }
      if (url.pathname === '/__cms/pages' && handlers.list) {
        const pages = handlers.list(url);
        return Response.json({ pages, total: pages.length });
      }
      if (handlers.get) return Response.json({ page: handlers.get() });
      return new Response('not found', { status: 404 });
    }));
    return new CmsClient({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'secret' });
  }

  it('recordCheckin appends to the existing checkin array (full read-modify-write)', async () => {
    const existing = guest({ lect: { checkin: [{ status: 'checked-in', date: 'x', message: formatMainMessage('kiosk') }] } });
    let putBody: any;
    const cms = stubCms({ get: () => existing, put: (body) => { putBody = body; } });

    await recordCheckin(cms, existing, formatPlusMessage(0, 'kiosk'));
    expect(putBody.lect.checkin).toHaveLength(2);
    expect(putBody.lect.checkin[1].message).toBe(formatPlusMessage(0, 'kiosk'));
    expect(putBody.lect.response).toEqual([
      expect.objectContaining({ status: 'checked-in', message: formatPlusMessage(0, 'kiosk') }),
    ]);
  });

  it('undoCheckin removes only the most recent matching entry and records an immutable undo activity', async () => {
    const existing = guest({
      lect: {
        checkin: [
          { status: 'checked-in', date: '1', message: formatPlusMessage(0, 'kiosk') },
          { status: 'checked-in', date: '2', message: formatMainMessage('kiosk') },
          { status: 'checked-in', date: '3', message: formatPlusMessage(0, 'kiosk', 'Grace') },
        ],
      },
    });
    let putBody: any;
    const cms = stubCms({ get: () => existing, put: (body) => { putBody = body; } });

    const { removed } = await undoCheckin(cms, existing, (parsed) => parsed.kind === 'plus' && parsed.index === 0);
    expect(removed).toBe(true);
    expect(putBody.lect.checkin).toHaveLength(2);
    expect(putBody.lect.checkin.map((e: { message: string }) => e.message)).toEqual([
      formatPlusMessage(0, 'kiosk'),
      formatMainMessage('kiosk'),
    ]);
    expect(putBody.lect.response).toEqual([
      expect.objectContaining({
        status: 'undo-plus-guest',
        message: 'undid plus guest 1 check-in from kiosk',
      }),
    ]);
  });

  it('undoCheckin is a no-op when nothing matches', async () => {
    const existing = guest({ lect: { checkin: [{ status: 'checked-in', date: '1', message: formatMainMessage('kiosk') }] } });
    const cms = stubCms({ get: () => existing });
    const { removed, guest: unchanged } = await undoCheckin(cms, existing, (parsed) => parsed.kind === 'session');
    expect(removed).toBe(false);
    expect(unchanged).toBe(existing);
  });

  it('findGuestByCode matches qrcode or barcode attributes', async () => {
    const guests = [guest({ id: 1, lect: { qrcode: 'ABC' } }), guest({ id: 2, lect: { barcode: 'XYZ' } })];
    const cms = stubCms({ list: () => guests });
    expect((await findGuestByCode(cms, 12, 'XYZ'))?.id).toBe(2);
    expect(await findGuestByCode(cms, 12, 'nope')).toBeNull();
  });

  it('searchGuests delegates text search to Worker CMS', async () => {
    const guests = [
      guest({ id: 1, name: 'Ada Lovelace', lect: { organization: 'Analytical Engines' } }),
    ];
    const cms = stubCms({
      list: (url) => {
        expect(url.searchParams.get('page_type')).toBe('guest');
        expect(url.searchParams.get('pointer_key')).toBe('mail_list');
        expect(url.searchParams.get('pointer_value')).toBe('12');
        expect(url.searchParams.get('q')).toBe('analytical');
        return guests;
      },
    });
    const results = await searchGuests(cms, 12, 'analytical');
    expect(results.map((g) => g.id)).toEqual([1]);
  });

  it('createWalkInGuest creates a confirmed guest scoped to the list', async () => {
    let createdBody: any;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        createdBody = JSON.parse(String(init.body));
        return Response.json({ page: { id: 99, page_type: 'guest', name: createdBody.name, page_id: createdBody.page_id, lect: createdBody.lect } });
      }
      return new Response('not found', { status: 404 });
    }));
    const cms = new CmsClient({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'secret' });
    const created = await createWalkInGuest(cms, 12, { name: 'Walk In', plusGuests: 2 });
    expect(created.id).toBe(99);
    expect(createdBody.lect).toMatchObject({ status: 'confirmed', plus_guests: '2', _pointers: { mail_list: '12' } });
  });
});
