// Read-only badge rendering. Badge design/CRUD lives in cms-plugin-events
// (src/labels.ts) — this plugin only reads the `label` pages an event admin
// already designed there and substitutes one guest's tokens into the SVG, so
// a kiosk can preview/print a badge without duplicating the design UI.
// renderLabel/safeSvg/escapeXml/guestTokens are a direct copy of that
// plugin's private helpers (kept local rather than shared, same rationale as
// crypto.ts).

import { attr, localized, type CmsClient, type CmsPage } from './cms';

export interface LabelFrame {
  width: string;
  height: string;
  direction: string;
  svg: string;
}

/** Lists an event's label templates (design-time pages created via the events plugin's admin). */
export async function eventLabels(cms: CmsClient, eventId: number): Promise<CmsPage[]> {
  const { pages } = await cms.list('label', { parentId: eventId, limit: 500 });
  return pages;
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

export function guestTokens(guest: CmsPage): Record<string, string> {
  return {
    name: guest.name || localized(guest.lect, 'name'),
    organization: attr(guest.lect, 'organization'),
    email: attr(guest.lect, 'email'),
    qr_code: attr(guest.lect, 'qrcode'),
  };
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
