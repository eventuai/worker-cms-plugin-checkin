import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { renderView } from '../src/templates/liquid';
import { signPayload } from '../src/crypto';
import { chineseSearchText } from '../src/chinese';

interface PluginEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  EVENTS_PLUGIN_SECRET?: string;
  VIEWS: Fetcher;
}

const plugin = worker as { fetch(request: Request, env: PluginEnv): Promise<Response> };

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        if (url.pathname === '/snippets/color-tag-picker.liquid') {
          return new Response(await readFile('/Users/colin/Documents/code/workers/cms/views/snippets/color-tag-picker.liquid', 'utf8'));
        }
        return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return { VIEWS: views(), ...overrides };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://checkin.test${path}`, init);
}

async function renderedText(response: Response): Promise<string> {
  if (response.headers.get('x-cms-client-view') !== '1') return response.text();
  const viewPath = response.headers.get('x-cms-view-path');
  if (!viewPath) throw new Error('Missing x-cms-view-path');
  const data = await response.clone().json() as Record<string, unknown>;
  return renderView(views(), viewPath, data);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('guest-list client search text', () => {
  it('contains simplified and traditional Chinese variants', () => {
    const searchText = chineseSearchText('蘇瑋');
    expect(searchText).toContain('蘇瑋');
    expect(searchText).toContain('苏玮');
  });
});

describe('plugin contract', () => {
  it('exposes the checkin manifest without a secret', async () => {
    const response = await plugin.fetch(request('/__plugin/manifest'), env({ PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(200);
    const manifest = await response.json();
    expect(manifest).toMatchObject({
      id: 'checkin',
      nav: [{ label: 'Check-in', href: 'dashboard', roles: ['admin', 'editor', 'moderator', 'event-helper'] }],
    });
    expect((manifest as { assets?: Array<{ path?: string }> }).assets).toContainEqual(expect.objectContaining({ path: '/assets/js/kiosk-labels.js' }));
  });

  it('requires the shared secret for admin routes', async () => {
    const response = await plugin.fetch(request('/__plugin/admin/dashboard'), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(403);
  });

  it('renders the dashboard with only active events fetched from the CMS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T04:00:00Z'));

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'event') {
        return Response.json({
          pages: [
            { id: 7, name: 'Launch Party', start: '2026-07-03 09:00 +0800', end: '2026-07-03 18:00 +0800', timezone: '+0800', lect: { kiosk_title: 'Welcome!' } },
            { id: 11, name: 'Ongoing Party', start: '2026-07-01', end: null, timezone: '+0800', lect: { kiosk_title: 'Still open' } },
            { id: 8, name: 'Past Party', start: '2026-07-01', end: '2026-07-02', timezone: '+0800', lect: { kiosk_title: 'Too late' } },
            { id: 9, name: 'Future Party', start: '2026-07-04', end: '2026-07-05', timezone: '+0800', lect: { kiosk_title: 'Too early' } },
            { id: 10, name: 'Undated Party', start: null, end: null, timezone: '+0800', lect: { kiosk_title: 'No dates' } },
          ],
          total: 4,
        });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(request('/__plugin/admin/dashboard', { headers: { 'x-plugin-secret': 'shared-secret' } }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-chrome')).toBe('1');
    const html = await renderedText(response);
    expect(html).toContain('Launch Party');
    expect(html).toContain('Ongoing Party');
    expect(html).not.toContain('Past Party');
    expect(html).not.toContain('Future Party');
    expect(html).not.toContain('Undated Party');
  });

  it('redirects the dashboard straight to its sole active event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T04:00:00Z'));

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'event') {
        return Response.json({
          pages: [
            { id: 7, name: 'Launch Party', start: '2026-07-03 09:00 +0800', end: '2026-07-03 18:00 +0800', timezone: '+0800', lect: {} },
            { id: 8, name: 'Past Party', start: '2026-07-01', end: '2026-07-02', timezone: '+0800', lect: {} },
          ],
          total: 2,
        });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(request('/__plugin/admin/dashboard', { headers: { 'x-plugin-secret': 'shared-secret' } }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/checkin/events/7');
  });

  it('checks a guest in from the admin search results and PUTs the checkin block', async () => {
    const updates: Array<{ id: number; body: { lect: { checkin: Array<{ status: string; date: string; message: string }> } } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/12' && (!init || init.method === undefined || init.method === 'GET')) {
        return Response.json({ page: { id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        expect(url.searchParams.get('q')).toBe('Ada');
        return Response.json({ pages: [{ id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: { organization: 'Analytical Engines' } }], total: 1 });
      }
      if (url.pathname === '/__cms/pages/34' && init?.method === 'GET') {
        return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: {} } });
      }
      if (url.pathname === '/__cms/pages/34' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        updates.push({ id: 34, body });
        return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: body.lect } });
      }
      return new Response('not found', { status: 404 });
    }));

    const testEnv = env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' });
    const search = await plugin.fetch(request('/__plugin/admin/rsvp/12/guests/search?q=Ada', { headers: { 'x-plugin-secret': 'shared-secret' } }), testEnv);
    expect(await renderedText(search)).toContain('Ada Lovelace');

    const checkin = await plugin.fetch(request('/__plugin/admin/rsvp/12/guests/34/checkin', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'return_to=%2Fadmin%2Fplugins%2Fcheckin%2Frsvp%2F12%2Fguests%2Fsearch',
    }), testEnv);

    expect(checkin.status).toBe(302);
    expect(updates).toHaveLength(1);
    expect(updates[0].body.lect.checkin[0]).toMatchObject({ status: 'checked-in', message: 'main attendee checked-in from kiosk' });
  });
});

describe('kiosk (login-gated admin surface)', () => {
  function stubEvent() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      }
      return new Response('not found', { status: 404 });
    }));
  }

  it('serves the scan page as camera-enabled chrome that loads the approved decoder scripts', async () => {
    stubEvent();
    const response = await plugin.fetch(
      request('/__plugin/admin/kiosk/7/scan', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-chrome')).toBe('1');
    // Opt-in flag the host translates into a relaxed (camera + wasm) CSP.
    expect(response.headers.get('x-cms-permissions')).toBe('camera');
    expect(decodeURIComponent(response.headers.get('x-cms-title') ?? '')).toBe('Launch Party');
    const html = await renderedText(response);
    expect(html).toContain('<div class="max-w-md">');
    expect(html).toContain('&larr; Launch Party</a>');
    expect(html).not.toContain('<h1 class="text-2xl font-bold text-gray-900">Launch Party</h1>');
    expect(html).toContain('id="scanVideoFrame"');
    expect(html).toContain('absolute inset-x-3 bottom-3');
    expect(html).toContain('id="scanVideo"');
    expect(html).toContain('id="scanCameraSelect"');
    expect(html).toContain('id="scanMirrorToggle"');
    // Scripts must point at the CMS-prefixed asset URL so the host allowlist keeps them.
    expect(html).toContain('/admin/plugins/checkin/assets/js/zxing-wasm.js');
    expect(html).toContain('/admin/plugins/checkin/assets/wasm/zxing_reader.wasm');
    expect(html).toContain('/admin/plugins/checkin/assets/js/kiosk.js');

    const kioskScript = await readFile(fileURLToPath(new URL('../views/assets/js/kiosk.js', import.meta.url).href), 'utf8');
    expect(kioskScript).toContain('waitForZXingWASM');
    expect(kioskScript).toContain('getZXingModule');
    expect(kioskScript).toContain('enumerateDevices');
    expect(kioskScript).toContain("addEventListener('wheel'");
    expect(kioskScript).toContain("addEventListener('touchmove'");
    expect(kioskScript).toContain('scanMirrorToggle');
    expect(kioskScript).toContain('checkin:kiosk:scanner-mirrored');
    expect(kioskScript).toContain('writeBooleanSetting(KIOSK_MIRROR_STORAGE_KEY, mirrored)');
    expect(kioskScript).toContain('checkin:kiosk:scanner-camera');
    expect(kioskScript).toContain('readStringSetting(KIOSK_CAMERA_STORAGE_KEY)');
    expect(kioskScript).toContain('writeStringSetting(KIOSK_CAMERA_STORAGE_KEY, selectedDeviceId)');
    expect(kioskScript).toContain("bitmapOutput.value = printCommands.join('\\n')");
    expect(kioskScript.match(/connectAndPrintWithBitmap\(bitmapOutput\)/g)).toHaveLength(1);
  });

  it('renders the kiosk settings page with the same left-aligned wrapper', async () => {
    stubEvent();
    const response = await plugin.fetch(
      request('/__plugin/admin/kiosk/7/settings', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    const html = await renderedText(response);

    expect(html).toContain('<div class="max-w-md">');
    expect(html).toContain('Printer mode');
    expect(html).toContain('href="/admin/plugins/checkin/events/7"');
    expect(html).not.toContain('>Search</a>');
  });

  it('checks a guest in from the kiosk and redirects back to the guest, scoping the guest to the event', async () => {
    const updates: Array<{ lect: { checkin: Array<{ status: string; message: string }>; response: Array<{ status: string; message: string }> } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? 'GET';
      if (url.pathname === '/__cms/pages/7' && method === 'GET') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      }
      if (url.pathname === '/__cms/pages/34' && method === 'GET') {
        return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: {} } });
      }
      // The guest's own list must belong to this event (pointer event -> 7).
      if (url.pathname === '/__cms/pages/12' && method === 'GET') {
        return Response.json({ page: { id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/34' && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        updates.push(body);
        return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: body.lect } });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(request('/__plugin/admin/kiosk/7/guests/34/checkin-main', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/checkin/kiosk/7/guests/34');
    expect(updates).toHaveLength(1);
    expect(updates[0].lect.checkin[0]).toMatchObject({ status: 'checked-in', message: 'main attendee checked-in from kiosk' });
    expect(updates[0].lect.response[0]).toMatchObject({ status: 'checked-in', message: 'main attendee checked-in from kiosk' });
  });

  it('undoes a kiosk check-in while adding an immutable guest activity entry', async () => {
    const updates: Array<{ lect: { checkin: Array<{ status: string; message: string }>; response: Array<{ status: string; message: string }> } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? 'GET';
      if (url.pathname === '/__cms/pages/7' && method === 'GET') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      if (url.pathname === '/__cms/pages/34' && method === 'GET') return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: { checkin: [{ status: 'checked-in', date: '2026-07-02', message: 'main attendee checked-in from kiosk' }], response: [{ status: 'checked-in', date: '2026-07-02', message: 'main attendee checked-in from kiosk' }] } } });
      if (url.pathname === '/__cms/pages/12' && method === 'GET') return Response.json({ page: { id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: { _pointers: { event: '7' } } } });
      if (url.pathname === '/__cms/pages/34' && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        updates.push(body);
        return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: body.lect } });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(request('/__plugin/admin/kiosk/7/guests/34/undo-main', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(updates[0].lect.checkin).toEqual([]);
    expect(updates[0].lect.response).toEqual([
      expect.objectContaining({ status: 'checked-in', message: 'main attendee checked-in from kiosk' }),
      expect.objectContaining({ status: 'undo-main-attendee', message: 'undid main attendee check-in from kiosk' }),
    ]);
  });

  it('opens the correct guest when the kiosk scans a signed Events QR token', async () => {
    const code = `12.34.${await signPayload('events-secret', '12.34')}`;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 12, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } }], total: 1 });
      }
      if (url.pathname === '/__cms/pages/34') {
        return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: {} } });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(request('/__plugin/admin/kiosk/7/scan', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret', EVENTS_PLUGIN_SECRET: 'events-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/checkin/kiosk/7/guests/34');
  });

  it('renders the kiosk guest back link with the event name and no search link', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      if (url.pathname === '/__cms/pages/34') return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: {} } });
      if (url.pathname === '/__cms/pages/12') return Response.json({ page: { id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: { _pointers: { event: '7' } } } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'label') return Response.json({
        pages: [
          { id: 50, page_type: 'label', name: 'Name badge', isPublished: true, lect: { design: JSON.stringify({ labelConfig: { width: 60, height: 30 }, textElements: [{ x: 10, y: 20, text: '[@name]' }] }) } },
          { id: 51, page_type: 'label', name: 'Staff badge', isPublished: true, lect: { design: JSON.stringify({ labelConfig: { width: 60, height: 30 }, textElements: [{ x: 10, y: 20, text: '[@organization]' }] }) } },
          { id: 52, page_type: 'label', name: 'Unpublished badge', isPublished: false, lect: { design: '{}' } },
        ], total: 3,
      });
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(
      request('/__plugin/admin/kiosk/7/guests/34', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    const html = await renderedText(response);

    expect(html).toContain('<div class="max-w-md">');
    expect(html).toContain('&larr; Launch Party</a>');
    expect(html).not.toContain('&larr; Scan</a>');
    expect(html).not.toContain('>Search</a>');
    expect(html).not.toContain('RFID tag');
    expect(html).toContain('Name badge');
    expect(html).toContain('Staff badge');
    expect(html).not.toContain('Unpublished badge');
    expect(html.match(/data-print-badges/g)).toHaveLength(1);
    expect(html).toContain('/admin/plugins/checkin/assets/js/encoder.js');
    expect(html).toContain('/admin/plugins/checkin/assets/js/printer.js');
    expect(html).toContain('/admin/plugins/checkin/assets/js/kiosk-labels.js');
  });

  it('shows RFID pairing only when the event enables rfid', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: { rfid: 'yes' } } });
      if (url.pathname === '/__cms/pages/34') return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: { barcode: 'RFID-001' } } });
      if (url.pathname === '/__cms/pages/12') return Response.json({ page: { id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: { _pointers: { event: '7' } } } });
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(
      request('/__plugin/admin/kiosk/7/guests/34', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    const html = await renderedText(response);

    expect(html).toContain('RFID tag');
    expect(html).toContain('Bound to: RFID-001');
  });

  it('rejects a guest that belongs to another event', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      if (url.pathname === '/__cms/pages/34') return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada', page_id: 12, lect: {} } });
      // list 12 points at a different event.
      if (url.pathname === '/__cms/pages/12') return Response.json({ page: { id: 12, page_type: 'mail_list', name: 'Other', page_id: null, lect: { _pointers: { event: '99' } } } });
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(
      request('/__plugin/admin/kiosk/7/guests/34', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    const html = await renderedText(response);
    expect(html).toContain('Guest not found.');
  });

  it('no longer serves the kiosk on the public (non-admin) surface', async () => {
    const response = await plugin.fetch(request('/kiosk/7'), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(404);
  });

  it('searches kiosk guests once and maps results back to the event guest lists', async () => {
    let guestSearches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [
          { id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: { _pointers: { event: '7' } } },
          { id: 13, page_type: 'mail_list', name: 'Press', page_id: null, lect: { _pointers: { event: '7' } } },
          { id: 99, page_type: 'mail_list', name: 'Other Event', page_id: null, lect: { _pointers: { event: '99' } } },
        ], total: 3 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        guestSearches += 1;
        expect(url.searchParams.get('q')).toBe('陳');
        expect(url.searchParams.get('pointer_key')).toBe('mail_list');
        expect(url.searchParams.get('pointer_values')).toBe('12,13');
        expect(url.searchParams.has('pointer_value')).toBe(false);
        return Response.json({ pages: [
          { id: 34, page_type: 'guest', name: '陳美玲', page_id: 12, lect: { organization: 'Analytical Engines' } },
          { id: 35, page_type: 'guest', name: '陳家豪', page_id: 13, lect: { organization: 'Daily Planet' } },
          { id: 36, page_type: 'guest', name: '陳外部', page_id: 99, lect: { organization: 'Other Org' } },
        ], total: 3 });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(
      request('/__plugin/admin/kiosk/7/search?q=%E9%99%B3', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    const html = await renderedText(response);

    expect(guestSearches).toBe(1);
    expect(html).toContain('陳美玲');
    expect(html).toContain('VIP');
    expect(html).toContain('陳家豪');
    expect(html).toContain('Press');
    expect(html).not.toContain('陳外部');
    expect(html).not.toContain('Other Event');
  });

  it('filters a search by a custom field value derived from the event blocks', async () => {
    let guestSearches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: { _blocks: [{ _type: 'rsvp-custom', _weight: 0, custom_input: [{ label: 'Meal preference' }] }] } } });
      }
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: { id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/34') {
        return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: { organization: 'AE', plus_guests: '1', checkin: [{ status: 'checked-in', date: '2026-07-02', message: 'main attendee checked-in from kiosk' }] } } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: { _pointers: { event: '7' } } }], total: 1 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        guestSearches += 1;
        expect(url.searchParams.get('q')).toBe('vegan');
        expect(url.searchParams.get('pointer_key')).toBe('mail_list');
        expect(url.searchParams.get('pointer_values')).toBe('12');
        expect(url.searchParams.has('pointer_value')).toBe(false);
        return Response.json({ pages: [
          { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: { rsvp_custom_meal_preference: 'Vegan' } },
          { id: 35, page_type: 'guest', name: 'Bob Halal', page_id: 12, lect: { rsvp_custom_meal_preference: 'Halal' } },
        ], total: 2 });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(
      request('/__plugin/admin/kiosk/7/search?field=rsvp_custom_meal_preference&q=vegan', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    const html = await renderedText(response);
    expect(html).toContain('<div class="max-w-md">');
    expect(html).toContain('Searching by Meal preference');
    expect(html).toContain('Ada Lovelace');
    expect(html).not.toContain('Bob Halal');
    expect(guestSearches).toBe(1);
  });
});

describe('event dashboard (parity with legacy guest-lists page)', () => {
  function stubEventWithData() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: { _blocks: [{ _type: 'rsvp-custom', _weight: 0, custom_input: [{ label: 'Meal preference' }] }] } } });
      }
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: { id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/34') {
        return Response.json({ page: { id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: { organization: 'AE', plus_guests: '1', checkin: [{ status: 'checked-in', date: '2026-07-02', message: 'main attendee checked-in from kiosk' }] } } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: { _pointers: { event: '7' } } }], total: 1 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        return Response.json({ pages: [{ id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: { organization: 'AE', plus_guests: '1', checkin: [{ status: 'checked-in', date: '2026-07-02' }] } }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    }));
  }

  it('renders the search box, custom-field search, event summary, nav and walk-in footer', async () => {
    stubEventWithData();
    const response = await plugin.fetch(
      request('/__plugin/admin/events/7', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('Search all guests');           // top search box
    expect(html).toContain('Search by custom field');       // custom-field search
    expect(html).toContain('Meal preference');              // derived custom field option
    expect(html).toContain('data-custom-field-select');
    expect(html).toContain('checkin:event-dashboard:custom-field:7');
    expect(html).toContain('Event summary');                // summary card
    expect(html).toContain('Check in unlisted guest');      // walk-in footer
    expect(html).toContain('data-walkin-heading-toggle');
    expect(html).toContain('data-walkin-panel');
    expect(html).toContain('checkin:event-dashboard:walkin-collapsed:7');
    expect(html).toContain('data-walkin-panel-body class="hidden mt-3"');
    expect(html).toContain('data-walkin-toggle aria-expanded="false"');
    expect(html).toContain('/admin/plugins/checkin/assets/js/event-dashboard.js');
    expect(html.match(/href="\/admin\/plugins\/checkin\/dashboard"/g)).toHaveLength(1); // top back-to-events link only
    expect(html).toContain('/admin/plugins/checkin/kiosk/7/scan');     // scan nav
    expect(html).toContain('/admin/plugins/checkin/kiosk/7/settings'); // settings nav
    expect(html).toContain('href="/admin/plugins/checkin/events/7/all-guests"');
    expect(html).not.toContain('/admin/plugins/events/events/7/all-guests');
    expect(html).toContain('/admin/plugins/checkin/events/7/lists/12');
    expect(html).not.toContain('Search guests');
    // 1 guest, 1 checked in → 100%
    expect(html).toContain('100%');
  });

  it('orders guest lists by weight, matching the Events dashboard', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        // Deliberately reversed API order: the lower-weight list belongs first.
        return Response.json({ pages: [
          { id: 12, page_type: 'mail_list', name: 'Later list', weight: 20, lect: { _pointers: { event: '7' } } },
          { id: 13, page_type: 'mail_list', name: 'First list', weight: 1, lect: { _pointers: { event: '7' } } },
        ], total: 2 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        return Response.json({ pages: [], total: 0 });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(
      request('/__plugin/admin/events/7', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    const html = await renderedText(response);
    expect(html.indexOf('First list')).toBeLessThan(html.indexOf('Later list'));
  });

  it('renders an event-scoped guest-list detail page with every guest', async () => {
    stubEventWithData();
    const response = await plugin.fetch(
      request('/__plugin/admin/events/7/lists/12', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('VIP');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('data-table-filter-form');
    expect(html).toContain('data-privacy-table');
    expect(html).toContain('data-private-field="name"');
    expect(html).toContain('data-private-field="email"');
    expect(html).toContain('data-filter-search="Ada Lovelace');
    expect(html).toContain('All statuses');
    expect(html).toContain('All color tags');
    expect(html).toContain('data-filter-status="Not sent"');
    expect(html).toContain('/admin/plugins/checkin/kiosk/7/guests/34?return_to=%2Fadmin%2Fplugins%2Fcheckin%2Fevents%2F7%2Flists%2F12');
    expect(html).toContain('href="/admin/plugins/checkin/kiosk/7/scan"');
    expect(html).toContain('href="/admin/plugins/checkin/kiosk/7/settings"');
    expect(html).toContain('Checked in');
  });

  it('renders a separate check-in all-guests page across every event list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [
          { id: 12, page_type: 'mail_list', name: 'VIP', weight: 1, lect: { _pointers: { event: '7' } } },
          { id: 13, page_type: 'mail_list', name: 'Press', weight: 2, lect: { _pointers: { event: '7' } } },
        ], total: 2 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        const listId = url.searchParams.get('pointer_value');
        if (listId === '12') {
          return Response.json({ pages: [{ id: 34, page_type: 'guest', name: 'Ada Lovelace', page_id: 12, lect: { email: 'ada@example.com', status: 'confirmed' } }], total: 1 });
        }
        if (listId === '13') {
          return Response.json({ pages: [{ id: 35, page_type: 'guest', name: 'Grace Hopper', page_id: 13, lect: { email: 'grace@example.com', status: 'invited' } }], total: 1 });
        }
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(
      request('/__plugin/admin/events/7/all-guests', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('All guests');
    expect(html).toContain('across every list');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Grace Hopper');
    expect(html).toContain('VIP');
    expect(html).toContain('Press');
    expect(html).toContain('data-privacy-table');
    expect(html).toContain('/admin/plugins/checkin/kiosk/7/guests/34?return_to=%2Fadmin%2Fplugins%2Fcheckin%2Fevents%2F7%2Fall-guests');
    expect(html).not.toContain('/admin/plugins/events/');
  });

  it('renders the first 100 check-in guests and progressively embeds the remainder', async () => {
    const guests = Array.from({ length: 105 }, (_, index) => ({
      id: index + 1,
      page_type: 'guest',
      name: index === 104 ? 'Guest 105 </script><script>unsafe()</script>' : `Guest ${String(index + 1).padStart(3, '0')}`,
      page_id: 12,
      lect: { email: `guest-${index + 1}@example.com`, status: 'confirmed' },
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch Party', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 12, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } }], total: 1 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        expect(url.searchParams.get('pointer_value')).toBe('12');
        return Response.json({ pages: guests, total: guests.length });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(
      request('/__plugin/admin/events/7/all-guests', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    const html = await renderedText(response);

    expect(html).toContain('data-checkin-all-guests-async');
    expect(html).toContain('Rendering 100 of 105 matching guests…');
    expect(html).toContain('<script src="/admin/plugins/checkin/assets/js/event-dashboard.js" defer></script>');
    expect((html.match(/data-guest-row/g) ?? [])).toHaveLength(100);
    expect(html).toContain('Guest 100');
    expect(html).not.toContain('Guest 101</a>');
    expect(html).toContain('\\u003c/script\\u003e');

    const embedded = html.match(/<div hidden data-checkin-all-guests-json>([\s\S]*?)<\/div>/);
    expect(embedded).not.toBeNull();
    const deferred = JSON.parse(embedded?.[1] ?? '[]') as Array<{ id: number; name: string; guestHref: string }>;
    expect(deferred).toHaveLength(5);
    expect(deferred[0]).toMatchObject({ id: 101, name: 'Guest 101' });
    expect(deferred[4]).toMatchObject({ id: 105, name: 'Guest 105 </script><script>unsafe()</script>' });
    expect(deferred[4].guestHref).toContain('/admin/plugins/checkin/kiosk/7/guests/105');
  });

  it('returns a guest opened from a list to that guest list', async () => {
    stubEventWithData();
    const response = await plugin.fetch(
      request('/__plugin/admin/kiosk/7/guests/34?return_to=%2Fadmin%2Fplugins%2Fcheckin%2Fevents%2F7%2Flists%2F12', { headers: { 'x-plugin-secret': 'shared-secret' } }),
      env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }),
    );
    const html = await renderedText(response);
    expect(html).toContain('href="/admin/plugins/checkin/events/7/lists/12"');
  });
});
