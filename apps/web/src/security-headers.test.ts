import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import './lib/zod-csp';

// The headers Vercel adds to every static and SPA response (apps/web/vercel.json). `vite
// preview`, and so the E2E suite, serves the same rule (vite.config.ts).
type HeaderRule = { source: string; headers: { key: string; value: string }[] };
// Plain paths: under jsdom, `URL` is jsdom's class, which node:fs doesn't accept.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(readFileSync(join(webRoot, 'vercel.json'), 'utf8')) as {
  headers: HeaderRule[];
};
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');

const spaRules = vercel.headers.filter((rule) => rule.source === '/(.*)');
const spaHeaders = spaRules[0]?.headers ?? [];
const header = (name: string) =>
  spaHeaders.find(({ key }) => key.toLowerCase() === name.toLowerCase())?.value;

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name!, sources]),
  );
}
const csp = directives(header('Content-Security-Policy') ?? '');

function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    ([, body]) => `'sha256-${createHash('sha256').update(body!, 'utf8').digest('base64')}'`,
  );
}

describe('SPA security headers (vercel.json)', () => {
  it('has one catch-all rule with no duplicate headers', () => {
    expect(spaRules).toHaveLength(1);
    const names = spaHeaders.map(({ key }) => key.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('sets the expected Content-Security-Policy directives', () => {
    expect(Object.fromEntries(csp)).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'", ...inlineScriptHashes(indexHtml)],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'"],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    });
  });

  it("allows index.html's inline theme script by hash, and nothing else inline", () => {
    const hashes = inlineScriptHashes(indexHtml);
    // Editing the pre-paint theme script changes its hash: update script-src to match.
    expect(hashes).toHaveLength(1);
    expect(csp.get('script-src')).toEqual(["'self'", ...hashes]);
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('never allows eval, wildcards or other origins', () => {
    for (const [name, sources] of csp) {
      expect(sources, name).not.toContain("'unsafe-eval'");
      expect(sources, name).not.toContain("'wasm-unsafe-eval'");
      for (const source of sources) {
        expect(source, name).not.toMatch(/\*|^https?:|^data:|^blob:/);
      }
    }
  });

  it("keeps inline styles' exfiltration channels closed", () => {
    // 'unsafe-inline' styles are the one exception (Radix's scroll lock injects a <style>
    // with a measured value). Injected CSS can't load url(...) from another origin.
    expect(csp.get('img-src')).toEqual(["'self'"]);
    expect(csp.get('font-src')).toEqual(["'self'"]);
    expect(csp.get('default-src')).toEqual(["'self'"]);
  });

  it('forbids framing in both the modern and legacy header', () => {
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(header('X-Frame-Options')).toBe('DENY');
  });

  it('sends HSTS for two years without includeSubDomains or preload', () => {
    expect(header('Strict-Transport-Security')).toBe('max-age=63072000');
  });

  it('isolates the browsing context and resources', () => {
    expect(header('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(header('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('keeps the existing hardening headers', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });
});

describe('Zod under the CSP', () => {
  it('runs jitless, so it never probes for eval', () => {
    expect(z.config().jitless).toBe(true);
  });
});
