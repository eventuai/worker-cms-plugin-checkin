// ============================================================
// Worker CMS plugin — "checkin".
//
// Owns the event check-in surface: QR/barcode scanning, guest lookup,
// main-attendee/plus-guest/session check-in, walk-in registration and badge
// printing. Reads/writes the event/mail_list/guest/label pages
// cms-plugin-events' blueprint already defines — this plugin adds no content
// types of its own. All staff-facing check-in (dashboard + the door kiosk)
// lives on CMS-session-gated admin routes; the only public route is the
// guest-facing direct QR check-in link (/checkin/*) on its own domain.
// ============================================================

import { adminView, redirect, requirePluginSecret, serveViewAsset } from '@lionrockjs/worker-cms-plugin';
import { CmsApiError, CmsClient, CmsNotConfiguredError } from './cms';
import { handleCheckinAdmin } from './admin';
import { handlePublicCheckin, type PublicEnv } from './public';
import { checkinAccessForRequest, forbidden } from './permissions';
// The plugin manifest is plain data, so it lives as a static JSON file served
// verbatim at /__plugin/manifest rather than being assembled from constants here.
import MANIFEST from './manifest.json';

interface PluginEnv extends PublicEnv {
  PLUGIN_SECRET?: string;
  CMS_URL?: string;
}

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/__plugin/admin')) {
      const forbiddenResponse = requirePluginSecret(request, env.PLUGIN_SECRET);
      if (forbiddenResponse) return forbiddenResponse;
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    if (path.startsWith('/__plugin/admin')) {
      return handleAdmin(request, env, url);
    }

    // Static assets (kiosk camera scanner + badge printing scripts, decoder
    // wasm). The host proxies these through its admin plugin-asset allowlist
    // (admin-approved + hash-pinned) by fetching ${PLUGIN_ORIGIN}/assets/*
    // here, so the kiosk chrome can load them under the strict admin CSP.
    if (path.startsWith('/assets/')) {
      return serveViewAsset(env.VIEWS, path);
    }

    try {
      const publicResponse = await handlePublicCheckin(request, env, url);
      if (publicResponse) return publicResponse;
    } catch (error) {
      console.error('[checkin] public route failed', error);
      return new Response('Something went wrong. Please try again.', { status: 500 });
    }

    return new Response('not found', { status: 404 });
  },
};

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const jsonOnly = wantsJson(url);

  // The CMS client-side renderer fetches plugin views through
  // /admin/plugins/{id}/views/* → /__plugin/admin/views/* — serve them here.
  if (segments[0] === 'views') {
    const viewPath = `/${segments.slice(1).join('/')}`;
    if (
      viewPath === '/color-tag-picker.liquid' ||
      viewPath === '/snippets/color-tag-picker.liquid' ||
      viewPath === '/sections/color-tag-picker.liquid'
    ) {
      return redirect(`/admin/views/snippets/color-tag-picker.liquid${url.search}`);
    }
    if (viewPath.startsWith('/snippets/pagefield/')) {
      return redirect(`/admin/views${viewPath}${url.search}`);
    }
    return serveViewAsset(env.VIEWS, viewPath, { bareLiquidSnippets: true });
  }

  let cms: CmsClient;
  try {
    cms = new CmsClient(env);
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) return adminView(env.VIEWS, 'Error', 'error', { message: error.message, showConfig: true }, jsonOnly);
    throw error;
  }

  const access = checkinAccessForRequest(request);
  if (!access.canView) return forbidden();

  // Awaited (not bare-returned) so a CmsApiError raised deep inside a handler
  // is caught here and rendered as an error panel rather than escaping as an
  // unhandled 500 with a stack trace.
  try {
    return await handleCheckinAdmin(request, cms, env.VIEWS, segments, url, jsonOnly, access);
  } catch (error) {
    if (error instanceof CmsApiError) return adminView(env.VIEWS, 'Error', 'error', { message: error.message }, jsonOnly);
    throw error;
  }
}

function wantsJson(url: URL): boolean {
  const json = url.searchParams.get('json')?.trim().toLowerCase();
  const format = url.searchParams.get('format')?.trim().toLowerCase();
  return format === 'json' || (url.searchParams.has('json') && json !== '0' && json !== 'false');
}
