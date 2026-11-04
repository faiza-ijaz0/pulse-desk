import { z } from 'zod';

/**
 * The production Content-Security-Policy (apps/web/vercel.json) has no `'unsafe-eval'`, so
 * Zod's JIT fast path, which compiles parsers with `new Function`, can never run in the
 * browser. Without this, Zod still probes for it with a caught `Function('')` on first parse,
 * and the browser reports that as a CSP violation on every page load. `jitless` skips the
 * probe and selects the interpreted path the CSP already forces; validation results are the
 * same.
 *
 * Schemas read the flag when they're created (at module scope), so this must run before any
 * schema module. main.tsx imports it first for development and tests, and the production
 * build puts it in Zod's own `data` chunk (vite.config.ts), which every schema chunk depends
 * on, because import order isn't preserved across chunks.
 */
z.config({ jitless: true });
