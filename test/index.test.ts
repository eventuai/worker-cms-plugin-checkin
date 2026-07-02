import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { renderView } from '../src/templates/liquid';

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
  });

  it('requires the shared secret for admin routes', async () => {
    const response = await plugin.fetch(request('/__plugin/admin/dashboard'), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(403);
  });

  it('renders the dashboard with events fetched from the CMS', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'event') {
        return Response.json({ pages: [{ id: 7, name: 'Launch Party', lect: { kiosk_title: 'Welcome!' } }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    }));

    const response = await plugin.fetch(request('/__plugin/admin/dashboard', { headers: { 'x-plugin-secret': 'shared-secret' } }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-chrome')).toBe('1');
    const html = await renderedText(response);
    expect(html).toContain('Launch Party');
    expect(html).toContain('Welcome!');
  });

  it('checks a guest in from the admin search results and PUTs the checkin block', async () => {
    const updates: Array<{ id: number; body: { lect: { checkin: Array<{ status: string; date: string; message: string }> } } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/12' && (!init || init.method === undefined || init.method === 'GET')) {
        return Response.json({ page: { id: 12, page_type: 'mail_list', name: 'VIP', page_id: null, lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
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
    const html = await renderedText(response);
    expect(html).toContain('id="scanVideo"');
    // Scripts must point at the CMS-prefixed asset URL so the host allowlist keeps them.
    expect(html).toContain('/admin/plugins/checkin/assets/js/zxing-wasm.js');
    expect(html).toContain('/admin/plugins/checkin/assets/js/kiosk.js');
  });

  it('checks a guest in from the kiosk and redirects back to the guest, scoping the guest to the event', async () => {
    const updates: Array<{ lect: { checkin: Array<{ status: string; message: string }> } }> = [];
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
});
