#!/usr/bin/env node
import { Command } from 'commander';
import * as ops from '../tools/operations.js';
import { SingularityError } from '../core/errors.js';
import { toJson } from '../core/format.js';
import { allChains } from '../core/registry.js';
import { adapterFor } from '../adapters/index.js';
import { VERSION } from '../version.js';
import * as render from './render.js';

const program = new Command();

program
  .name('singularity')
  .description(
    'Universal blockchain CLI across EVM, Solana, Bitcoin and Cosmos. Read-only: it holds no keys and never signs.',
  )
  .version(VERSION)
  .option('--json', 'Output raw JSON instead of formatted text.')
  .showHelpAfterError();

/** Print either JSON or the pretty rendering, depending on the global --json. */
function emit(value: unknown, pretty: (value: never) => string): void {
  if (program.opts().json) {
    console.log(toJson(value));
    return;
  }
  console.log(pretty(value as never));
}

program
  .command('chains')
  .description('List supported chains.')
  .argument('[query]', 'Filter by name, id, alias, symbol, or chain id.')
  .option('-f, --family <family>', 'Restrict to evm, svm, utxo, or cosmos.')
  .action((query: string | undefined, options: { family?: string }) => {
    emit(ops.listChains(query, options.family), render.renderChains);
  });

program
  .command('resolve')
  .description('Identify an address, transaction hash, or name, and which chains it belongs to.')
  .argument('<input>', 'Address, tx hash, ENS/SNS name, or block number.')
  .option('-c, --chain <chain>', 'Chain id or alias, when already known.')
  .action(async (input: string, options: { chain?: string }) => {
    emit(await ops.resolve(input, options.chain), render.renderResolve);
  });

program
  .command('balance')
  .description('Native and token balances for an address on one chain.')
  .argument('<address>', 'Address, ENS/SNS name, or configured alias.')
  .requiredOption('-c, --chain <chain>', 'Chain id or alias.')
  .option('-t, --token <token...>', 'Specific token addresses, mints, or denoms.')
  .option('--no-tokens', 'Fetch only the native balance.')
  .option('--at-block <height>', 'Read as of this block height (EVM and Cosmos archive endpoints).')
  .action(
    async (
      address: string,
      options: { chain: string; token?: string[]; tokens: boolean; atBlock?: string },
    ) => {
      const result = await ops.getBalance({
        address,
        chain: options.chain,
        tokens: options.token,
        includeTokens: options.tokens,
        atBlock: options.atBlock,
      });
      emit(result, render.renderBalance);
    },
  );

program
  .command('portfolio')
  .description('Balances for one address across many chains at once.')
  .argument('<address>', 'Address, ENS/SNS name, or configured alias.')
  .option('-c, --chain <chain...>', 'Chains to query. Defaults to a spread across all families.')
  .option('--no-tokens', 'Native balances only (much faster).')
  .action(async (address: string, options: { chain?: string[]; tokens: boolean }) => {
    const result = await ops.getPortfolio({
      address,
      chains: options.chain,
      includeTokens: options.tokens,
    });
    emit(result, render.renderPortfolio);
  });

program
  .command('tx')
  .description('Look up a transaction, searching across chains when none is given.')
  .argument('<hash>', 'Transaction hash, txid, or Solana signature.')
  .option('-c, --chain <chain>', 'Chain id, to skip the cross-chain search.')
  .action(async (hash: string, options: { chain?: string }) => {
    const result = await ops.getTransaction({ hash, chain: options.chain });

    if (program.opts().json) {
      console.log(toJson(result));
      return;
    }

    for (const tx of result.found) console.log(render.renderTx(tx));
    if (result.note) console.log(`\n  ${render.yellow(result.note)}`);
  });

program
  .command('block')
  .description('Fetch a block by height, hash, or "latest".')
  .requiredOption('-c, --chain <chain>', 'Chain id or alias.')
  .argument('[ref]', 'Block height, hash, or "latest".', 'latest')
  .action(async (ref: string, options: { chain: string }) => {
    emit(await ops.getBlock({ chain: options.chain, ref }), render.renderBlock);
  });

program
  .command('fees')
  .description('Current fee conditions on a chain.')
  .requiredOption('-c, --chain <chain>', 'Chain id or alias.')
  .action(async (options: { chain: string }) => {
    emit(await ops.getFees(options.chain), render.renderFees);
  });

program
  .command('read')
  .description('Read an EVM view function, or parsed Solana account data.')
  .requiredOption('-c, --chain <chain>', 'Chain id or alias.')
  .requiredOption('-a, --address <address>', 'Contract or account address.')
  .option('-m, --method <method>', 'EVM function name, e.g. balanceOf.')
  .option(
    '--abi <abi>',
    'Human-readable ABI entry, e.g. "function balanceOf(address) view returns (uint256)".',
  )
  .option('--arg <arg...>', 'Arguments for the call, in order.')
  .option('--at-block <height>', 'Call against this block height instead of the chain tip.')
  .action(
    async (options: {
      chain: string;
      address: string;
      method?: string;
      abi?: string;
      arg?: string[];
      atBlock?: string;
    }) => {
      const result = await ops.readContract({
        chain: options.chain,
        address: options.address,
        method: options.method,
        abi: options.abi,
        args: options.arg,
        atBlock: options.atBlock,
      });
      console.log(toJson(result));
    },
  );

program
  .command('decode')
  .description('Decode EVM calldata into a function signature and arguments.')
  .argument('<data>', 'Hex calldata, with or without the 0x prefix.')
  .option('--abi <abi...>', 'Human-readable ABI entries to decode against.')
  .action((data: string, options: { abi?: string[] }) => {
    console.log(toJson(ops.decode(data, options.abi)));
  });

program
  .command('build')
  .description('Build an UNSIGNED transfer for you to sign in your own wallet.')
  .requiredOption('-c, --chain <chain>', 'Chain id or alias.')
  .requiredOption('--to <address>', 'Recipient address, name, or alias.')
  .requiredOption('--amount <amount>', 'Human decimal amount, e.g. 1.5.')
  .option('--from <address>', 'Sender. Required on Solana, Bitcoin, and Cosmos.')
  .option('--token <token>', 'Token contract, mint, denom, or known symbol.')
  .option('--memo <memo>', 'Memo, on chains that support one.')
  .action(
    async (options: {
      chain: string;
      to: string;
      amount: string;
      from?: string;
      token?: string;
      memo?: string;
    }) => {
      emit(await ops.buildTransfer(options), render.renderUnsignedTx);
    },
  );

program
  .command('mcp')
  .description('Run the MCP server on stdio, for Claude Code and other MCP clients.')
  .action(async () => {
    const { createServer } = await import('../mcp/server.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const server = createServer();
    await server.connect(new StdioServerTransport());
    process.stderr.write(`singularity-agent MCP server ${VERSION} ready on stdio\n`);
  });

program
  .command('doctor')
  .description('Check which configured RPC endpoints are actually reachable.')
  .option('-c, --chain <chain...>', 'Chains to check. Defaults to all of them.')
  .action(async (options: { chain?: string[] }) => {
    const targets = options.chain?.length
      ? options.chain.map((id) => allChains().find((c) => c.id === id) ?? null).filter(Boolean)
      : allChains();

    console.log(render.heading('Endpoint health'));

    const results = await Promise.all(
      (targets as NonNullable<(typeof targets)[number]>[]).map(async (chain) => {
        const adapter = adapterFor(chain);
        const started = Date.now();
        try {
          if (adapter.healthCheck) await adapter.healthCheck(chain);
          else await adapter.getBlock(chain, 'latest');
          return [render.green('ok'), chain.id, `${Date.now() - started}ms`, ''];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return [
            render.red('fail'),
            chain.id,
            `${Date.now() - started}ms`,
            render.dim(truncate(message, 110)),
          ];
        }
      }),
    );

    console.log(render.table(results));

    const failures = results.filter((r) => r[0]?.includes('fail')).length;
    console.log(
      failures
        ? `\n  ${render.yellow(`${failures} chain(s) unreachable.`)} ${render.dim('Public endpoints rate-limit aggressively — set SINGULARITY_RPC_<CHAIN> to your own.')}`
        : `\n  ${render.green('All endpoints reachable.')}`,
    );
  });

/** Trim on a word boundary so a cut-off host or reason stays readable. */
function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof SingularityError) {
      console.error(`\n  ${render.red(err.code)}  ${err.message}`);
      if (err.hint) console.error(`  ${render.dim(err.hint)}\n`);
      process.exit(1);
    }
    console.error(`\n  ${render.red('ERROR')}  ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

void main();
