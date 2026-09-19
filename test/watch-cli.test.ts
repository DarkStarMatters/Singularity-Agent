import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * `singularity watch`, run as an actual process.
 *
 * Every other test in this file's neighbourhood imports a function and calls
 * it. That would not have caught the bug this command shipped with in
 * development: `pollLoop` unrefs its timer, so with nothing refd holding the
 * event loop open, Node exited after the first tick. The command printed one
 * line, returned 0, and looked like it had worked. Awaiting the subscription's
 * `done` promise did not help, because a pending promise is not a reason for
 * Node to stay up.
 *
 * No unit test of the loop can see that — the loop was behaving exactly as
 * designed. It is a property of the *process*, so it is tested as one.
 *
 * These run against a local fake rather than a public endpoint. A test that
 * needs Solana to be up is a test that fails on a train.
 */

const run = promisify(execFile);
const CLI = resolve(__dirname, '..', 'src', 'cli', 'index.ts');
const TSX = resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * A stub chain served from memory, whose height climbs on every read.
 *
 * Configured through `SINGULARITY_CONFIG`, the same path a user's own chain
 * definition takes, so this exercises the real registry rather than a mock of
 * it.
 */
interface RpcRequest {
  method?: string;
  params?: unknown[];
  id?: number;
}

async function withFakeChain<T>(
  handler: (request: RpcRequest) => unknown,
  body: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const { createServer } = await import('node:http');

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const request = raw ? (JSON.parse(raw) as RpcRequest) : {};
      const result = handler(request);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? 1, result }));
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;

  try {
    return await body({
      ...process.env,
      SINGULARITY_RPC_ETHEREUM: `http://127.0.0.1:${port}`,
      NO_COLOR: '1',
    });
  } finally {
    server.close();
  }
}

/**
 * A chain whose head advances by one every time `latest` is asked for.
 *
 * The tag matters. `getBlock('latest')` is `eth_getBlockByNumber` with
 * `"latest"`, and finality resolution asks the same method for `"finalized"`
 * on the same tick — so advancing on every call to that method would make the
 * height jump around and the finalized head overtake the tip. Only `latest`
 * moves; `finalized` trails it by a fixed distance, which is what a real chain
 * looks like.
 */
function climbingChain() {
  let height = 0x100;

  const block = (n: number) => ({
    number: `0x${n.toString(16)}`,
    hash: `0x${n.toString(16).padStart(64, '0')}`,
    parentHash: `0x${'cd'.repeat(32)}`,
    timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
    transactions: [],
    gasUsed: '0x0',
    gasLimit: '0x0',
    baseFeePerGas: '0x1',
  });

  return (request: RpcRequest): unknown => {
    switch (request.method) {
      case 'eth_chainId':
        return '0x1';

      case 'eth_blockNumber':
        return `0x${height.toString(16)}`;

      case 'eth_getBlockByNumber': {
        const tag = request.params?.[0];
        if (tag === 'latest') return block(height++);
        if (tag === 'finalized' || tag === 'safe') return block(height - 32);
        return block(Number(BigInt(String(tag ?? '0x0'))));
      }

      case 'eth_getBlockByHash':
        return block(height);

      default:
        return null;
    }
  };
}

const cli = (env: NodeJS.ProcessEnv, args: string[]) =>
  run(process.execPath, [TSX, CLI, ...args], { env, timeout: 60_000 });

describe('singularity watch, as a process', () => {
  it('survives past the first tick and reports every change', async () => {
    // The regression test for the unref bug. Three changes means the process
    // had to stay alive across two intervals; the broken version produced one
    // line and exited 0.
    const { stdout } = await withFakeChain(climbingChain(), (env) =>
      cli(env, ['watch', 'tip', '-c', 'ethereum', '-i', '1', '-n', '3']),
    );

    const changes = stdout.split('\n').filter((line) => /#\d+/.test(line));
    expect(changes).toHaveLength(3);
    expect(changes[0]).toMatch(/first reading/);

    // A positive delta, not specifically +1: finality resolution asks this
    // fake for `latest` too, so the head advances more than once per tick.
    // Pinning the exact number here would be asserting an artefact of the
    // stub rather than anything about the command.
    expect(changes[1]).toMatch(/\+\d+/);
  }, 60_000);

  it('exits 0 once it has seen the changes it was asked for', async () => {
    const { stdout } = await withFakeChain(climbingChain(), (env) =>
      cli(env, ['watch', 'tip', '-c', 'ethereum', '-i', '1', '-n', '2']),
    );

    expect(stdout).toContain('#');
  }, 60_000);

  it('emits newline-delimited JSON under --json, one object per change', async () => {
    // Not the indented form the rest of the CLI uses. A watch is a stream, and
    // `jq`, a log shipper and `grep` all want one record per line.
    const { stdout } = await withFakeChain(climbingChain(), (env) =>
      cli(env, ['--json', 'watch', 'tip', '-c', 'ethereum', '-i', '1', '-n', '3']),
    );

    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      const record = JSON.parse(line) as { kind: string; at: string; height: number };
      expect(record.kind).toBe('tip');
      expect(Date.parse(record.at)).not.toBeNaN();
      expect(typeof record.height).toBe('number');
    }

    // And the heights are ascending, which is the thing being watched.
    const heights = lines.map((l) => (JSON.parse(l) as { height: number }).height);
    expect([...heights].sort((a, b) => a - b)).toEqual(heights);
  }, 60_000);

  it('keeps the pretty header out of the JSON stream', async () => {
    // A stray heading on stdout makes the first line unparseable, which is the
    // classic way a --json mode is broken for everyone piping it.
    const { stdout } = await withFakeChain(climbingChain(), (env) =>
      cli(env, ['--json', 'watch', 'tip', '-c', 'ethereum', '-i', '1', '-n', '1']),
    );

    expect(stdout).not.toMatch(/Watching/);
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  }, 60_000);

  it('rejects a nonsense interval rather than silently using the default', async () => {
    await expect(
      withFakeChain(climbingChain(), (env) =>
        cli(env, ['watch', 'tip', '-c', 'ethereum', '-i', 'soon']),
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('INVALID_INTERVAL') });
  }, 60_000);

  it('documents that it polls, in its own help', async () => {
    // The gap between "subscribed" and "asked every twelve seconds" is where a
    // caller draws a wrong conclusion, so the help has to say which it is.
    const { stdout } = await cli({ ...process.env, NO_COLOR: '1' }, ['watch', '--help']);

    expect(stdout).toMatch(/not a subscription/i);
    expect(stdout).toMatch(/balance|tip|tx|liveness/);
  }, 60_000);
});
