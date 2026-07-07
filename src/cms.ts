// ============================================================
// Check-in plugin's CMS bridge.
//
// Shared Plugin API client/types and neutral lect readers live in
// @lionrockjs/worker-cms-plugin. This file adds only the check-in-specific
// helpers that read data shaped by cms-plugin-events' blueprint (event,
// mail_list, guest, label) without depending on that plugin's source.
// ============================================================

import {
  CmsClient as BaseCmsClient,
  attr,
  blocks,
  items,
  pointer,
  localized,
  type CmsClientEnv,
  type CmsPage,
  type CmsPageInput,
  CmsApiError,
  CmsNotConfiguredError,
} from '@lionrockjs/worker-cms-plugin';

/** Manifest id — must equal MANIFEST.id and the CMS-registered plugin id. */
export const PLUGIN_ID = 'checkin';

export {
  CmsApiError,
  CmsNotConfiguredError,
  attr,
  blocks,
  items,
  localized,
  pointer,
  type CmsPage,
  type CmsClientEnv,
  type CmsPageInput,
};

export class CmsClient extends BaseCmsClient {
  private readonly cmsUrl: string;
  private readonly pluginSecret: string;

  constructor(env: CmsClientEnv) {
    super({ cmsUrl: env.CMS_URL, pluginSecret: env.PLUGIN_SECRET, pluginId: PLUGIN_ID, fetcher: (input, init) => globalThis.fetch(input, init) });
    this.cmsUrl = String(env.CMS_URL ?? '').replace(/\/+$/, '');
    this.pluginSecret = String(env.PLUGIN_SECRET ?? '');
  }

  async listByPointerValues(
    pageType: string,
    pointerKey: string,
    pointerValues: Array<number | string>,
    opts: { q?: string; limit?: number; offset?: number } = {},
  ): Promise<{ pages: CmsPage[]; total: number }> {
    const values = pointerValues.map(String).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
    if (values.length === 0) return { pages: [], total: 0 };

    const params = new URLSearchParams({
      page_type: pageType,
      pointer_key: pointerKey,
      pointer_values: values.join(','),
    });
    if (opts.q) params.set('q', opts.q);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.offset != null) params.set('offset', String(opts.offset));

    const path = `/pages?${params.toString()}`;
    const response = await globalThis.fetch(`${this.cmsUrl}/__cms${path}`, {
      method: 'GET',
      headers: {
        'x-plugin-secret': this.pluginSecret,
        'x-plugin-id': PLUGIN_ID,
      },
    });
    if (!response.ok) throw new CmsApiError(response.status, await cmsErrorCode(response), 'GET', path);
    return response.json() as Promise<{ pages: CmsPage[]; total: number }>;
  }
}

async function cmsErrorCode(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return 'error';
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === 'string' && body.error ? body.error : 'error';
  } catch {
    return text.replace(/\s+/g, ' ').trim().slice(0, 160) || 'error';
  }
}

export interface GuestListSummary {
  guest_count: number;
  guest_total: number;
  checked_in_count: number;
  checked_in_total: number;
}

/**
 * Selects a related collection of pages by pointer (e.g. a guest's list is
 * `_pointers.mail_list`, NOT its parent page) — `event`/`mail_list` pages
 * group by pointer, not by parent page id.
 */
export async function listByEvent(cms: CmsClient, pageType: string, eventId: number, opts: { limit?: number } = {}): Promise<CmsPage[]> {
  const { pages } = await cms.list(pageType, { limit: opts.limit ?? 500 });
  const target = String(eventId);
  return pages.filter((page) => pointer(page.lect, 'event') === target);
}

/**
 * Real check-in entries for a guest. The host seeds every blueprint block,
 * including `checkin`, with one empty row when a page is created. A row
 * counts only once it carries an actual status or date. Mirrors
 * cms-plugin-events/src/cms.ts `checkins()` exactly, since both plugins read
 * the same `guest.lect.checkin` array.
 */
export function checkins(lect: Record<string, unknown>): Array<Record<string, unknown>> {
  return items(lect, 'checkin').filter((entry) => String(entry.status ?? '').trim() !== '' || String(entry.date ?? '').trim() !== '');
}

export function emptyGuestListSummary(): GuestListSummary {
  return { guest_count: 0, guest_total: 0, checked_in_count: 0, checked_in_total: 0 };
}

/** Tallies a list's guest pages for the check-in dashboard. */
export function computeGuestListSummary(guests: CmsPage[]): GuestListSummary {
  const summary = emptyGuestListSummary();
  for (const guest of guests) {
    const plus = Number.parseInt(attr(guest.lect, 'plus_guests'), 10);
    const headcount = (Number.isFinite(plus) && plus > 0 ? plus : 0) + 1;
    const checkedIn = checkins(guest.lect).length > 0;

    summary.guest_count += 1;
    summary.guest_total += headcount;
    if (checkedIn) {
      summary.checked_in_count += 1;
      summary.checked_in_total += headcount;
    }
  }
  return summary;
}

/**
 * True for the auto-managed "Adhoc" list cms-plugin-events creates per event
 * (src/rsvp.ts `isAdhocList`/`ensureAdhocGuestList`). Matched the exact same
 * way that plugin matches it — case-insensitive, trimmed name `"adhoc"` —
 * since check-in walk-ins should land in the same list admin-triggered adhoc
 * guests do.
 */
export function isAdhocGuestList(list: CmsPage): boolean {
  return list.page_type === 'mail_list' && list.name.trim().toLowerCase() === 'adhoc';
}
