// Read-only badge rendering. Badge design/CRUD lives in cms-plugin-events
// (src/labels.ts) — this plugin only reads the `label` pages an event admin
// already designed there and substitutes one guest's tokens into the SVG, so
// a kiosk can preview/print a badge without duplicating the design UI.
// renderLabel/safeSvg/escapeXml/guestTokens are a direct copy of that
// plugin's private helpers (kept local rather than shared, same rationale as
// crypto.ts).

import { compareByWeightThenName } from '@lionrockjs/worker-cms-plugin';
import { attr, localized, type CmsClient, type CmsPage } from './cms';
import { compactCheckinCode } from './qr-links';

export interface LabelFrame {
  width: string;
  height: string;
  direction: string;
  svg: string;
}

/** Lists the published label templates configured in the Events admin. */
export async function eventLabels(cms: CmsClient, eventId: number): Promise<CmsPage[]> {
  const { pages } = await cms.listWithLiveStatus('label', { parentId: eventId, limit: 500 });
  // Match the Events admin's label sequence so kiosk previews and the badge
  // endpoint use the same order as /events/:eventId/labels.
  return pages.filter((label) => label.isPublished === true).sort(compareByWeightThenName);
}

/** The Events plugin stores the editor document as JSON in `lect.design`. */
export function labelDesign(label: CmsPage): string {
  return attr(label.lect, 'design');
}

export function labelFrame(label: CmsPage): LabelFrame {
  const value = label.lect.frame;
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    width: String(record.width ?? '60mm'),
    height: String(record.height ?? '30mm'),
    direction: String(record.direction ?? 'landscape'),
    svg: String(record.svg ?? ''),
  };
}

export function guestTokens(guest: CmsPage, list?: CmsPage, event?: CmsPage): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(guest.lect)) {
    if (key.startsWith('_')) continue;
    const token = key.replace(/[^A-Za-z0-9_]/g, '_');
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') tokens[token] = String(value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) tokens[token] = localized(guest.lect, key);
  }
  tokens.name = guest.name || localized(guest.lect, 'name');
  tokens.organization ||= attr(guest.lect, 'organization');
  tokens.email ||= attr(guest.lect, 'email');
  tokens.qr_code = attr(guest.lect, 'qrcode');
  tokens.lead_id = String(guest.id);
  tokens.lead_id_short = guest.id.toString(36);
  if (list) {
    tokens.mail_list_id = String(list.id);
    tokens.mail_list_id_short = list.id.toString(36);
    try {
      // Label designs' QR elements default to [@checkin_qrcode] (see the
      // Events plugin's label editor); the aliases match its guestLabelTokens.
      const code = compactCheckinCode(list.id, guest.id);
      tokens.checkin_qrcode = code;
      tokens.checkin_qrcode_text = code;
      tokens.checkin_qr_code_text = code;
    } catch {
      // Guests outside the legacy id scheme simply get no QR token.
    }
  }
  if (event) {
    tokens.event_id = String(event.id);
    tokens.event_slug = event.slug ?? '';
  }
  return tokens;
}

export function renderLabel(svg: string, values: Record<string, string>): string {
  return safeSvg(svg).replace(/{{\s*([a-z_]+)\s*}}/g, (_all, key: string) => escapeXml(values[key] ?? ''));
}

function safeSvg(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, '');
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] as string));
}
