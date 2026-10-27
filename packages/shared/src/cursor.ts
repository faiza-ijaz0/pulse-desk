import type { z } from 'zod';

// Opaque pagination cursors: base64url-encoded JSON. This package runs in both Node and the
// browser without DOM or Node typings (no atob/Buffer), so it carries a small codec. The
// JSON is made ASCII-only first (non-ASCII characters become \uXXXX escapes), so every
// character fits in one byte.

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(ascii: string): string {
  let out = '';
  for (let i = 0; i < ascii.length; i += 3) {
    const remaining = Math.min(3, ascii.length - i);
    let chunk = 0;
    for (let b = 0; b < 3; b++)
      chunk = (chunk << 8) | (b < remaining ? ascii.charCodeAt(i + b) : 0);
    for (let c = 0; c <= remaining; c++)
      out += BASE64URL_ALPHABET.charAt((chunk >> (18 - 6 * c)) & 63);
  }
  return out;
}

function fromBase64Url(encoded: string): string | null {
  if (encoded.length % 4 === 1) return null;
  let out = '';
  for (let i = 0; i < encoded.length; i += 4) {
    const group = encoded.slice(i, i + 4);
    let chunk = 0;
    for (let c = 0; c < 4; c++) {
      const value = c < group.length ? BASE64URL_ALPHABET.indexOf(group.charAt(c)) : 0;
      if (value === -1) return null;
      chunk = (chunk << 6) | value;
    }
    for (let b = 0; b < group.length - 1; b++) {
      out += String.fromCharCode((chunk >> (16 - 8 * b)) & 255);
    }
  }
  return out;
}

/** Opaque to clients: they pass back the `nextCursor` they were given, unchanged. */
export function encodeCursor(payload: unknown): string {
  const json = JSON.stringify(payload).replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return toBase64Url(json);
}

/** The cursor's payload if it is well formed and matches `schema`, otherwise null. */
export function decodeCursor<Schema extends z.ZodType>(
  value: string,
  schema: Schema,
  maxLength: number,
): z.infer<Schema> | null {
  if (value === '' || value.length > maxLength) return null;
  const json = fromBase64Url(value);
  if (json === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
