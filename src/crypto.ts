// HMAC-SHA256 sign/verify — identical scheme to cms-plugin-events/src/crypto.ts.
// Duplicated locally (not in the shared @lionrockjs/worker-cms-plugin package,
// same as the events plugin's own copy) since it's ~15 lines and this plugin
// must interoperate with tokens signed by two different secrets: its own
// PLUGIN_SECRET (kiosk session cookies) and a copy of the events plugin's
// PLUGIN_SECRET (verifying already-minted guest QR links).

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signPayload(secret: string, data: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(data));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyPayload(secret: string, data: string, hexSignature: string): Promise<boolean> {
  const bytes = hexSignature.match(/.{1,2}/g)?.map((hex) => parseInt(hex, 16));
  if (!bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), new Uint8Array(bytes), new TextEncoder().encode(data));
}
