/* eslint-disable no-console -- build script output */
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
};

// Third-party runtime dependencies stay external (installed in production with
// `pnpm deploy`/`--prod`); workspace packages are TypeScript sources and get bundled.
const external = Object.entries(pkg.dependencies)
  .filter(([, version]) => !version.startsWith('workspace:'))
  .map(([name]) => name);

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

const result = await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // pino-pretty is a dev-only dependency loaded lazily in development.
  external: [...external, 'pino-pretty'],
  metafile: true,
  logLevel: 'warning',
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`Built dist/server.js (${(bytes / 1024).toFixed(1)} KiB incl. source map)`);
