// Event/guest-list custom fields — the "Search by custom field" surface.
//
// cms-plugin-events lets an organiser add `rsvp-custom` blocks (each with
// `custom_input` rows) to an event or guest list; guest responses land on the
// guest lect under `rsvp_custom_<slug>` (and a legacy `rsvp-custom-<slug>`
// key / `latest_response.admin`). This mirrors that plugin's
// `adminCustomFieldsForGuest` / `guestCustomFieldValue` (src/rsvp.ts) closely
// enough to read the same values, without depending on its source.

import { attr, blocks, items, localized, type CmsPage } from './cms';

export interface CustomField {
  /** Current lect key (`rsvp_custom_<slug>`), also the query-param value. */
  key: string;
  /** Legacy lect key (`rsvp-custom-<slug>`) still present on older guests. */
  legacyKey: string;
  label: string;
}

function fieldSlug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function legacyFieldSlug(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '-').replace(/[/()]/g, '');
}

function customBlocks(page: CmsPage): Array<Record<string, unknown>> {
  return blocks(page.lect).filter(
    (block) => attr(block, '_type') === 'rsvp-custom' && items(block, 'custom_input').length > 0,
  );
}

/**
 * The distinct custom fields defined across an event and its guest lists,
 * de-duplicated by key (first label wins), in declaration order.
 */
export function eventCustomFields(event: CmsPage | null, lists: CmsPage[]): CustomField[] {
  const fields: CustomField[] = [];
  const seen = new Set<string>();
  const sources = [...(event ? customBlocks(event) : []), ...lists.flatMap(customBlocks)];
  for (const block of sources) {
    for (const input of items(block, 'custom_input')) {
      const label = localized(input, 'label') || attr(input, 'label') || attr(input, 'name');
      if (!label) continue;
      const key = `rsvp_custom_${fieldSlug(label)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push({ key, legacyKey: `rsvp-custom-${legacyFieldSlug(label)}`, label });
    }
  }
  return fields;
}

/** A guest's stored value for a custom field (current key, legacy key, or the admin response bag). */
export function guestCustomFieldValue(guest: CmsPage, field: CustomField): string {
  const direct = attr(guest.lect, field.key) || attr(guest.lect, field.legacyKey);
  if (direct) return direct;
  const latest = guest.lect.latest_response;
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) return '';
  const admin = (latest as Record<string, unknown>).admin;
  if (!admin || typeof admin !== 'object' || Array.isArray(admin)) return '';
  const values = admin as Record<string, unknown>;
  return String(values[field.key] ?? values[field.legacyKey] ?? '').trim();
}
