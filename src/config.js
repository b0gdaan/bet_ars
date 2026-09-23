import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
// A BOM from Notepad would otherwise hide the first key; names may contain digits.
export function parseEnv(text) {
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text, values = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}
export function loadEnv() {
  try {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(join(root, '.env'), 'utf8'))))
      if (!process.env[key]) process.env[key] = value;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
loadEnv();
export const dataDir = process.env.CS2_DATA_DIR || join(root, 'data');
export const CS2_SINCE = '2023-09-27T00:00:00.000Z';
