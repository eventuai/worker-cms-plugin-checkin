// Simplified/Traditional Chinese conversion for client-side guest-list search.
// The character maps are generated from the OpenCC dictionaries.

import { S2T_KEYS, S2T_VALS, T2S_KEYS, T2S_VALS } from './chinese-chars';

function buildMap(keys: string, vals: string): Map<string, string> {
  const map = new Map<string, string>();
  const keyChars = [...keys];
  const valueChars = [...vals];
  for (let i = 0; i < keyChars.length; i++) map.set(keyChars[i], valueChars[i]);
  return map;
}

const S2T = buildMap(S2T_KEYS, S2T_VALS);
const T2S = buildMap(T2S_KEYS, T2S_VALS);

function convert(value: string, map: Map<string, string>): string {
  let out = '';
  for (const char of value) out += map.get(char) ?? char;
  return out;
}

export function toTraditional(value: string): string {
  return convert(value, S2T);
}

export function toSimplified(value: string): string {
  return convert(value, T2S);
}

/** Both script forms, for search text emitted into a client-side table row. */
export function chineseSearchText(value: string): string {
  const traditional = toTraditional(value);
  const simplified = toSimplified(value);
  return [...new Set([value, traditional, simplified])].join(' ');
}
