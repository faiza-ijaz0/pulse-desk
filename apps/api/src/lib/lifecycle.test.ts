import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.ts';
import { createShutdown } from './lifecycle.ts';

const logger = createLogger({ level: 'silent', version: 'test' });
const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.closeAllConnections();
});

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function get(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ port, host: '127.0.0.1', path: '/', agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createShutdown', () => {
  it('lets in-flight requests finish, then exits cleanly', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { server, port } = await listen((_req, res) => {
      void gate.then(() => res.end('done'));
    });
    const exit = vi.fn();
    const onClose = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({ server, logger, timeoutMs: 5_000, onClose, exit });

    const inFlight = get(port);
    await new Promise((r) => setTimeout(r, 50)); // request reaches the handler
    const done = shutdown('SIGTERM');

    await expect(get(port)).rejects.toThrow(); // no new connections accepted
    release();
    await expect(inFlight).resolves.toEqual({ status: 200, body: 'done' });
    await done;

    expect(onClose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('force-closes connections and exits with 1 when the deadline passes', async () => {
    const { server, port } = await listen(() => {
      /* never responds */
    });
    const exit = vi.fn();
    const shutdown = createShutdown({ server, logger, timeoutMs: 100, exit });

    const hung = get(port).catch(() => 'connection closed');
    await new Promise((r) => setTimeout(r, 50));
    await shutdown('SIGTERM');

    expect(await hung).toBe('connection closed');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('is idempotent when signalled repeatedly', async () => {
    const { server } = await listen((_req, res) => res.end());
    const exit = vi.fn();
    const shutdown = createShutdown({ server, logger, timeoutMs: 1_000, exit });

    await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-zero exit code for fatal errors', async () => {
    const { server } = await listen((_req, res) => res.end());
    const exit = vi.fn();
    await createShutdown({ server, logger, timeoutMs: 1_000, exit })('uncaughtException', 1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
