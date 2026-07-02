// ============================================================
// Check-in plugin's CMS bridge.
//
// Shared F1 client/types and neutral lect readers live in
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
  constructor(env: CmsClientEnv) {
    super({ cmsUrl: env.CMS_URL, pluginSecret: env.PLUGIN_SECRET, pluginId: PLUGIN_ID, fetcher: (input, init) => globalThis.fetch(input, init) });
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
