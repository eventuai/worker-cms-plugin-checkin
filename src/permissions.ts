// Mirrors cms-plugin-events/src/permissions.ts exactly (same CMS role
// vocabulary: admin, editor, moderator, event-helper) so a user's existing
// CMS role carries over into this plugin with no extra configuration.

export interface CheckinAccess {
  canView: boolean;
  canCheckIn: boolean;
}

const FULL_ACCESS: CheckinAccess = { canView: true, canCheckIn: true };
const NO_ACCESS: CheckinAccess = { canView: false, canCheckIn: false };

export function checkinAccessForRequest(request: Request): CheckinAccess {
  const roles = cmsUserRoles(request);

  // Direct secret-authenticated calls predate x-cms-user forwarding in tests
  // and local tooling. Treat those as trusted full-access calls.
  if (!roles.length) return { ...FULL_ACCESS };
  if (roles.includes('admin') || roles.includes('editor')) return { ...FULL_ACCESS };

  const canView = roles.includes('moderator') || roles.includes('event-helper');
  if (!canView) return { ...NO_ACCESS };

  return { canView: true, canCheckIn: roles.includes('event-helper') };
}

function cmsUserRoles(request: Request): string[] {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { role?: unknown };
    if (typeof parsed.role !== 'string') return [];
    return [...new Set(parsed.role.split(',').map((role) => role.trim().toLowerCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

export function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}
