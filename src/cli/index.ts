#!/usr/bin/env node
import { Command } from 'commander';
import * as ops from '../tools/operations.js';
import { SingularityError } from '../core/errors.js';
import { toJson } from '../core/format.js';
import { allChains } from '../core/registry.js';
import { adapterFor } from '../adapters/index.js';
import { VERSION } from '../version.js';
import * as render from './render.js';
import { parseBudget, type ResponseBudget } from '../core/budget.js';
import { pollLoop } from '../core/watch.js';
import { balanceIdentity } from '../tools/operations.js';

/**
 * Read `--budget` off the command line.
 *
 * A flag arrives as a string whatever it means, so "40" has to become a count
 * here rather than being handed on as a name nothing recognizes. An unusable
 * value is rejected rather than ignored: silently falling back to the default
 * would answer a mistyped `--budget ful` with a full-sized response and no
 * indication the flag did nothing.
 */
function cliBudget(value: string | undefined): ResponseBudget | undefined {
  if (value === undefined) return undefined;

  const parsed = parseBudget(/^\d+$/.test(value.trim()) ? Number(value) : value.trim());
  if (!parsed) {
    throw new SingularityError(
      'INVALID_BUDGET',
      `"${value}" is not a response budget.`,
      'Use small, standard, full, or a positive whole number of items.',
    );
  }
  return parsed;
}

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
  .option('--budget <size>', "How much of each list to return: small, standard, full, or an exact count.")
  .action(
    async (
      address: string,
      options: {
        chain: string;
        token?: string[];
        tokens: boolean;
        atBlock?: string;
        budget?: string;
      },
    ) => {
      const result = await ops.getBalance({
        address,
        chain: options.chain,
        tokens: options.token,
        includeTokens: options.tokens,
        atBlock: options.atBlock,
        budget: cliBudget(options.budget),
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
  .option('--budget <size>', "How much of each list to return: small, standard, full, or an exact count.")
  .action(
    async (address: string, options: { chain?: string[]; tokens: boolean; budget?: string }) => {
      const result = await ops.getPortfolio({
        address,
        chains: options.chain,
        includeTokens: options.tokens,
        budget: cliBudget(options.budget),
      });
      emit(result, render.renderPortfolio);
    },
  );

program
  .command('history')
  .description("Recent transactions for an address on one chain, newest first.")
  .argument('<address>', 'Address, ENS/SNS name, or configured alias.')
  .requiredOption('-c, --chain <chain>', 'Chain id or alias.')
  .option('-n, --limit <count>', 'Exact entries to return. With --budget, the smaller wins.')
  .option('--budget <size>', "How much of each list to return: small, standard, full, or an exact count.")
  .option('--cursor <cursor>', 'Continuation token from a previous call.')
  .action(
    async (
      address: string,
      options: { chain: string; limit?: string; cursor?: string; budget?: string },
    ) => {
      const result = await ops.getHistory({
        address,
        chain: options.chain,
        // No default here. The adapter's own fallback is the default, and
        // restating it in the CLI is how the two drift apart.
        ...(options.limit ? { limit: Number(options.limit) } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        budget: cliBudget(options.budget),
      });

      if (program.opts().json) {
        console.log(toJson(result));
        return;
      }

      console.log(render.renderHistory(result));
    },
  );

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
  .command('mint')
  .description('Audit a Solana mint: its authorities, its extensions, and what they let someone do.')
  .argument('<mint>', 'Mint address.')
  .option('-c, --chain <chain>', 'Solana chain id or alias.', 'solana')
  .action(async (mint: string, options: { chain: string }) => {
    emit(await ops.auditMint({ mint, chain: options.chain }), render.renderMintAudit);
  });

program
  .command('decode')
  .description('Decode EVM calldata into a function signature and arguments.')
  .argument('<data>', 'Hex calldata, with or without the 0x prefix.')
  .option('--abi <abi...>', 'Human-readable ABI entries to decode against.')
  .option(
    '--lookup',
    'If the selector is unknown, ask a public 4-byte directory for candidate signatures. Off by default: it discloses the selector to a third party, and anyone may submit an entry there.',
  )
  .action(async (data: string, options: { abi?: string[]; lookup?: boolean }) => {
    console.log(toJson(await ops.decode(data, options.abi, options.lookup)));
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
  .command('burn')
  .description('Build an UNSIGNED burn of a Solana token for you to sign in your own wallet.')
  .requiredOption('-m, --mint <mint>', 'Mint address, or an address-book alias.')
  .requiredOption('-a, --amount <amount>', 'Human decimal amount to destroy.')
  .requiredOption('-o, --owner <owner>', 'The wallet holding the tokens.')
  .option(
    '--memo <memo>',
    'Text to write into the transaction, signed with it. What lets this burn be credited to you rather than to whoever quotes the signature first.',
  )
  .option('-c, --chain <chain>', 'Solana chain id or alias.', 'solana')
  .action(
    async (options: {
      mint: string;
      amount: string;
      owner: string;
      memo?: string;
      chain: string;
    }) => {
      emit(await ops.buildBurn(options), render.renderUnsignedTx);
    },
  );

program
  .command('verify-burn')
  .description('Confirm a burn from its signature, and check it against a claim.')
  .argument('<signature>', 'The transaction signature.')
  .option('-m, --mint <mint>', 'The mint the burn must be of.')
  .option('-o, --owner <owner>', 'The wallet that must have signed it.')
  .option('--min <amount>', 'The least that must have been destroyed.')
  .option('--expect-memo <text>', "Text the burn's memo must contain for this claim to be yours.")
  .option('-c, --chain <chain>', 'Solana chain id or alias.', 'solana')
  .action(
    async (
      signature: string,
      options: {
        mint?: string;
        owner?: string;
        min?: string;
        expectMemo?: string;
        chain: string;
      },
    ) => {
      emit(
        await ops.verifyBurn({
          signature,
          mint: options.mint,
          owner: options.owner,
          minimum: options.min,
          expectMemo: options.expectMemo,
          chain: options.chain,
        }),
        render.renderBurnClaim,
      );
    },
  );

program
  .command('redeem')
  .description('Redeem a burn once: confirm it, then record it as spent.')
  .argument('<signature>', 'The transaction signature.')
  .requiredOption('-m, --mint <mint>', 'The mint the burn must be of.')
  .option('-o, --owner <owner>', 'The wallet that must have signed it.')
  .option('--min <amount>', 'The least that must have been destroyed.')
  .option('--expect-memo <text>', "Text the burn's memo must contain for this claim to be yours.")
  .option('-p, --purpose <purpose>', 'What this burn is being redeemed for.')
  .option('-c, --chain <chain>', 'Solana chain id or alias.', 'solana')
  .action(
    async (
      signature: string,
      options: {
        mint: string;
        owner?: string;
        min?: string;
        purpose?: string;
        expectMemo?: string;
        chain: string;
      },
    ) => {
      emit(
        await ops.redeemBurn({
          signature,
          mint: options.mint,
          owner: options.owner,
          minimum: options.min,
          purpose: options.purpose,
          expectMemo: options.expectMemo,
          chain: options.chain,
        }),
        render.renderBurnClaim,
      );
    },
  );

program
  .command('identity')
  .description('What a mint declares, and whether it can be changed afterwards.')
  .argument('<mint>', 'Mint address, or an address-book alias.')
  .option(
    '--fetch',
    'Also fetch the metadata document and read the accounts it declares. Off by default: the link is a URL chosen by whoever deployed the mint.',
  )
  .option('-c, --chain <chain>', 'Solana chain id or alias.', 'solana')
  .action(async (mint: string, options: { fetch?: boolean; chain: string }) => {
    emit(
      await ops.tokenIdentity({ mint, fetch: options.fetch, chain: options.chain }),
      render.renderTokenIdentity,
    );
  });

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

/**
 * `watch` — poll something and report what changes.
 *
 * Four subcommands rather than one guessing command, because the thing being
 * watched determines what a *change* even is, and that is not inferable from an
 * argument. A block number is the whole answer for a tip and irrelevant for a
 * balance; a transaction watch has a natural end and the others do not.
 *
 * What this is honest about, out loud and in `--help`: it polls. There is no
 * push feed here. A value that changed and changed back between two ticks is a
 * value this never saw, and a reorg is reported rather than smoothed over.
 *
 * `--json` emits one JSON object per change, newline-delimited, so the output
 * pipes into `jq` or a log shipper without anyone parsing a table.
 */
const watchCommand = program
  .command('watch')
  .description('Poll something and report changes. Ctrl-C to stop.')
  .addHelpText(
    'after',
    `
  This polls — it is not a subscription. It reports the state at the times it
  asked, so a value that changed and changed back between two ticks is not
  reported. Public endpoints are rate-limited; the interval floor is 1s.

  Examples:
    singularity watch balance vitalik.eth -c ethereum
    singularity watch tip -c solana -i 2
    singularity watch tx 0xabc… -c ethereum --confirmations 12
    singularity watch liveness -c ethereum -c base --json`,
  );

/**
 * Wire a running watch to the terminal.
 *
 * Shared by all four subcommands because the lifecycle is identical and getting
 * it subtly different per command is how one of them ends up not flushing on
 * Ctrl-C. Returns the promise the action awaits, so commander does not exit
 * while the watch is still running.
 */
function runWatch(subscription: {
  stop(): void;
  done: Promise<void>;
}): Promise<void> {
  let stopping = false;

  const onSignal = (): void => {
    // A second Ctrl-C should kill it outright. Someone pressing it twice has
    // decided they are done waiting for a graceful stop.
    if (stopping) process.exit(130);
    stopping = true;
    if (!program.opts().json) console.error(render.dim('\n  stopping…'));
    subscription.stop();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // `pollLoop` unrefs its timer, which is right for a library: a script that
  // starts a watch and then finishes its work should be allowed to exit. It is
  // wrong here, where the watch *is* the work — without a handle of its own the
  // process has nothing refd keeping the event loop alive, and Node exits after
  // the first tick with the command apparently having worked. Awaiting `done`
  // does not help, because a pending promise is not a reason for Node to stay
  // up. So the CLI holds the handle, which is the same thing the SDK's docs
  // tell a long-running application to do.
  const keepAlive = setInterval(() => {}, 1 << 30);

  return subscription.done.finally(() => {
    clearInterval(keepAlive);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  });
}

/**
 * One JSON object per line, or the pretty line. Never both.
 *
 * `--json` here is newline-delimited and compact, unlike everywhere else in
 * this CLI, where it is indented for a human reading one result. A watch is a
 * *stream*: its output goes to `jq`, to a log shipper, or to a file that gets
 * tailed, and every one of those wants one record per line. Indented output
 * would make each change span twenty lines and turn `grep` into a tool that
 * finds a fragment it cannot attribute to anything.
 */
function emitChange(kind: string, at: Date, payload: unknown, pretty: () => string | string[]): void {
  if (program.opts().json) {
    console.log(toJson({ kind, at: at.toISOString(), ...(payload as object) }, 0));
    return;
  }

  const rendered = pretty();
  for (const line of Array.isArray(rendered) ? rendered : [rendered]) {
    console.log(render.watchLine(at, line));
  }
}

/**
 * `--interval` in seconds, because nobody thinks about polling in
 * milliseconds. The floor lives in `pollLoop` and is not restated here —
 * a limit enforced in two places is a limit that disagrees with itself.
 */
function intervalMs(value: string | undefined, fallbackSeconds: number): number {
  if (value === undefined) return fallbackSeconds * 1_000;

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new SingularityError(
      'INVALID_INTERVAL',
      `"${value}" is not a number of seconds.`,
      'Pass a positive number, e.g. --interval 30. Intervals below 1 second are raised to 1.',
    );
  }
  return Math.round(seconds * 1_000);
}

watchCommand
  .command('balance')
  .description('Poll an address and report when its balance moves.')
  .argument('<address>', 'Address, ENS/SNS name, or configured alias.')
  .requiredOption('-c, --chain <chain>', 'Chain id or alias.')
  .option('-i, --interval <seconds>', 'Seconds between polls. Default 30.')
  .option('--no-tokens', 'Watch only the native balance (much cheaper).')
  .option('-n, --changes <count>', 'Stop after this many changes.')
  .action(
    async (
      address: string,
      options: { chain: string; interval?: string; tokens: boolean; changes?: string },
    ) => {
      const limit = options.changes ? Number(options.changes) : undefined;
      let seen = 0;

      if (!program.opts().json) {
        console.log(render.heading(`Watching ${address} on ${options.chain}`));
        console.log(render.dim('  Polling. Ctrl-C to stop.\n'));
      }

      const subscription = pollLoop(
        () => ops.getBalance({ address, chain: options.chain, includeTokens: options.tokens }),
        balanceIdentity,
        ({ value, previous, at }) => {
          seen += 1;
          emitChange('balance', at, { chain: value.chain, address, balance: value }, () =>
            render.watchBalanceChange(value, previous),
          );
        },
        {
          intervalMs: intervalMs(options.interval, 30),
          until: () => limit !== undefined && seen >= limit,
          onError: watchError,
          label: 'singularity watch balance',
        },
      );

      await runWatch(subscription);
    },
  );

watchCommand
  .command('tip')
  .description("Poll a chain's head and report each new block.")
  .requiredOption('-c, --chain <chain>', 'Chain id or alias.')
  .option('-i, --interval <seconds>', 'Seconds between polls. Default 12.')
  .option('-n, --changes <count>', 'Stop after this many blocks.')
  .action(async (options: { chain: string; interval?: string; changes?: string }) => {
    const limit = options.changes ? Number(options.changes) : undefined;
    let seen = 0;

    if (!program.opts().json) {
      console.log(render.heading(`Watching ${options.chain}`));
      console.log(render.dim('  Polling. Ctrl-C to stop.\n'));
    }

    const subscription = pollLoop(
      () => ops.getBlock({ chain: options.chain }),
      (block) => String(block.number),
      ({ value, previous, at }) => {
        seen += 1;
        emitChange('tip', at, { chain: options.chain, height: value.number, hash: value.hash }, () =>
          render.watchTipChange(value, previous),
        );
      },
      {
        intervalMs: intervalMs(options.interval, 12),
        until: () => limit !== undefined && seen >= limit,
        onError: watchError,
        label: 'singularity watch tip',
      },
    );

    await runWatch(subscription);
  });

watchCommand
  .command('tx')
  .description('Poll one transaction until it reaches a confirmation depth, then stop.')
  .argument('<hash>', 'Transaction hash or signature.')
  .option('-c, --chain <chain>', 'Chain id or alias. Searched across chains when omitted.')
  .option('--confirmations <count>', 'Depth to wait for. Default 1.')
  .option('-i, --interval <seconds>', 'Seconds between polls. Default 12.')
  .action(
    async (hash: string, options: { chain?: string; confirmations?: string; interval?: string }) => {
      const target = options.confirmations ? Number(options.confirmations) : 1;
      let settled = false;

      if (!program.opts().json) {
        console.log(render.heading(`Watching ${hash.slice(0, 18)}…`));
        console.log(render.dim(`  Waiting for ${target} confirmation(s). Ctrl-C to stop.\n`));
      }

      const subscription = pollLoop(
        async () => {
          const result = await ops.getTransaction({ hash, ...(options.chain ? { chain: options.chain } : {}) });
          const tx = result.found[0];
          // Not mined yet is neither a change nor an error. It prints nothing
          // and keeps waiting, because "not yet" and "never" are the same from
          // here and only one is worth interrupting somebody for.
          if (!tx) return undefined;
          if ((tx.finality?.confirmations ?? 0) >= target) settled = true;
          return tx;
        },
        (tx) => `${tx.status}|${tx.finality?.confirmations ?? 0}|${tx.finality?.kind ?? ''}`,
        ({ value, at }) => {
          emitChange('tx', at, { hash, chain: value.chain, status: value.status, finality: value.finality }, () =>
            render.watchTxChange(value, target),
          );
        },
        {
          intervalMs: intervalMs(options.interval, 12),
          until: () => settled,
          onError: watchError,
          label: 'singularity watch tx',
        },
      );

      await runWatch(subscription);

      // A transaction watch ends on its own, so it can report an outcome the
      // open-ended watches cannot. Exit non-zero if it stopped without ever
      // reaching the depth, so a script waiting on this can tell.
      if (!settled) process.exitCode = 1;
    },
  );

watchCommand
  .command('liveness')
  .description('Poll chain health and report every status change.')
  .option('-c, --chain <chain...>', 'Chains to watch. Defaults to all of them.')
  .option('-i, --interval <seconds>', 'Seconds between polls. Default 60.')
  .action(async (options: { chain?: string[]; interval?: string }) => {
    if (!program.opts().json) {
      console.log(render.heading('Watching chain liveness'));
      console.log(render.dim('  Polling. Ctrl-C to stop.\n'));
    }

    const subscription = pollLoop(
      () => ops.checkLiveness(options.chain),
      (all) => all.map((c) => `${c.chain}:${c.status}`).join(','),
      ({ value, previous, at }) => {
        emitChange('liveness', at, { chains: value }, () =>
          render.watchLivenessChange(value, previous),
        );
      },
      {
        // Liveness is the slowest-moving of these and the most expensive to
        // ask, since it probes every endpoint on every chain. A minute is
        // already aggressive against public infrastructure.
        intervalMs: intervalMs(options.interval, 60),
        onError: watchError,
        label: 'singularity watch liveness',
      },
    );

    await runWatch(subscription);
  });

/**
 * A failed tick, reported without stopping.
 *
 * Written to stderr so it does not corrupt a `--json` stream somebody is
 * piping. The watch keeps going and backs off, because one unreachable minute
 * is the normal condition of a public endpoint and is not a reason to abandon
 * a watch somebody left running overnight.
 */
function watchError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`  ${render.yellow('tick failed')}  ${truncate(message, 100)}`);
}

program
  .command('doctor')
  .description('Check whether each chain is serving current state, not just answering.')
  .option('-c, --chain <chain...>', 'Chains to check. Defaults to all of them.')
  .option('--endpoints', 'Show every endpoint rather than only the degraded ones.')
  .action(async (options: { chain?: string[]; endpoints?: boolean }) => {
    const report = await ops.checkLiveness(options.chain);

    if (program.opts().json) console.log(toJson(report));
    else {
      console.log(render.heading('Chain liveness'));
      console.log(render.renderLiveness(report, { endpoints: options.endpoints ?? false }));
    }

    // A stale chain is worse than a down one and must not exit 0: down is loud
    // at the call site, stale is an answer that looks fine.
    process.exitCode = report.some((c) => c.status === 'stale' || c.status === 'down') ? 1 : 0;
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
