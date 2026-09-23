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
import type { Objective as MeshObjective } from '../mesh/moves.js';
import { writeFileSync } from 'node:fs';
import { meshArtFacts, meshArtMetadata, meshArtStyle } from '../art/mesh-art.js';
import { meshArtPng } from '../art/mesh-raster.js';
import { pollLoop } from '../core/watch.js';
import { balanceIdentity } from '../tools/operations.js';
import { FileIntentStore, requireAllowedRecipient } from '../pay/file-store.js';
import { createIntent as createPayIntent, settleIntent } from '../pay/operations.js';
import { notifyPayment } from '../pay/notify.js';
import { qrMatrix } from '../core/qr.js';
import { qrUnicode } from '../core/qr-render.js';
import type { SettlementLevel } from '../pay/types.js';
import { createExchange } from '../exchange/privatedao.js';
import { quoteJob, settleJob } from '../exchange/buy.js';

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
  .description('Balances for one address, or a set of them, across many chains at once.')
  .argument(
    '<address...>',
    'One or more addresses, ENS/SNS names, or aliases. They may span chain families.',
  )
  .option('-c, --chain <chain...>', 'Chains to query. Defaults to a spread across all families.')
  .option('--no-tokens', 'Native balances only (much faster).')
  .option('--budget <size>', "How much of each list to return: small, standard, full, or an exact count.")
  .action(
    async (addresses: string[], options: { chain?: string[]; tokens: boolean; budget?: string }) => {
      const result = await ops.getPortfolio({
        addresses,
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
  .command('inspect')
  .description('Before buying a Solana token: what could stop you selling it again.')
  .argument('<mint>', 'Mint address, or an address-book alias for one.')
  .option('-c, --chain <chain>', 'Solana chain id or alias. Defaults to "solana".')
  .action(async (mint: string, options: { chain?: string }) => {
    const report = await ops.inspectExit({ mint, ...(options.chain ? { chain: options.chain } : {}) });

    if (program.opts().json) {
      console.log(toJson(report));
    } else {
      console.log(render.heading(`Exit analysis: ${render.dim(report.mint)}`));
      console.log(render.renderExitReport(report));
    }

    // Non-zero when something can stop a sale, so this drops into a script
    // that refuses to buy. Deliberately not non-zero for `degrades` findings:
    // a transfer fee is a reason to price differently, not to abort.
    process.exitCode = report.canExit ? 0 : 1;
  });


/**
 * `mesh` — the one command that is not a single call.
 *
 * Everything else here answers a question somebody already knew how to ask.
 * This takes the question, works out which of the other commands would answer
 * it, runs them in a cost-ordered order, and prints the search rather than
 * only its conclusion — including what it could not prove, which is the part
 * the other commands have no way to tell you.
 *
 * Exits non-zero when the objective was not fully answered, so a script can
 * refuse to proceed on a partial picture rather than reading `facts` and
 * assuming the gaps are zeroes.
 */
program
  .command('mesh')
  .description('Answer one question with several tools, searched, and say what it could not prove.')
  .argument('<objective>', 'identify | holdings | activity | settlement | safety | liveness')
  .argument('<subject>', 'An address, transaction hash, name, mint, alias, or a chain id for `liveness`.')
  .option('-c, --chain <chain>', 'Chain id or alias, when you already know it.')
  .option('--max-calls <n>', 'Hard ceiling on tool calls. Defaults to 8, capped at 16.')
  .option('--beam <n>', 'How many moves may run at once. Defaults to 3, capped at 5.')
  .option('--budget <size>', 'small | standard | full | a number, applied to the lists inside.')
  .option('--plan', 'Print the order the moves would run in, without calling anything.')
  .option('--art <file>', 'Also draw the run as a PNG and write it here.')
  .option('--series <name>', 'Series name for the artwork. Defaults to the objective.')
  .option('--edition <n>', 'Edition number for the artwork. Defaults to 1.')
  .option('--size <px>', 'Artwork size in pixels, square. Defaults to 1024.')
  .option('--metadata <file>', 'Write the NFT metadata JSON here. Needs --image-uri.')
  .option('--image-uri <url>', 'Where the image will be served from, for the metadata.')
  .action(
    async (
      objective: string,
      subject: string,
      options: {
        chain?: string;
        maxCalls?: string;
        beam?: string;
        budget?: string;
        plan?: boolean;
        art?: string;
        series?: string;
        edition?: string;
        size?: string;
        metadata?: string;
        imageUri?: string;
      },
    ) => {
      const result = await ops.mesh({
        subject,
        objective: objective as MeshObjective,
        ...(options.chain ? { chain: options.chain } : {}),
        ...(options.maxCalls ? { maxCalls: Number(options.maxCalls) } : {}),
        ...(options.beam ? { beam: Number(options.beam) } : {}),
        ...(cliBudget(options.budget) ? { budget: cliBudget(options.budget) } : {}),
        ...(options.plan ? { plan: true } : {}),
      });

      if (program.opts().json) {
        console.log(toJson(result));
      } else {
        console.log(render.heading(`Mesh: ${render.dim(objective)}`));
        console.log(render.renderMesh(result));
      }

      if (options.art || options.metadata) drawMesh(result, options);

      process.exitCode = result.verdict === 'answered' || result.verdict === 'planned' ? 0 : 1;
    },
  );

/**
 * Write the run's artwork, and the metadata that describes it.
 *
 * Split out of the action because it is the one part of `mesh` that touches
 * the filesystem, and because the refusal below is worth being able to find:
 * `meshArtMetadata` will not default the image location, so neither does this.
 * Which host holds your images, and for how long, is not a decision a CLI flag
 * should make silently on your behalf.
 */
function drawMesh(
  result: Awaited<ReturnType<typeof ops.mesh>>,
  options: { art?: string; series?: string; edition?: string; size?: string; metadata?: string; imageUri?: string },
): void {
  const facts = meshArtFacts(result, {
    series: options.series ?? result.objective,
    edition: options.edition ? Number(options.edition) : 1,
  });

  const style = meshArtStyle(facts);

  if (options.art) {
    const size = options.size ? Number(options.size) : undefined;
    writeFileSync(options.art, meshArtPng(facts, { style, ...(size ? { size } : {}) }));
    console.log(
      render.dim(
        `
Artwork: ${options.art} — ${style.field}, ${style.palette.name}, ${style.spokes}-fold, ${facts.voids.length} void(s)`,
      ),
    );
  }

  if (options.metadata) {
    if (!options.imageUri) {
      throw new SingularityError(
        'MISSING_IMAGE_URI',
        'Metadata needs to say where the image will be served from.',
        'Pass --image-uri. It is deliberately not defaulted: which host holds the image, and for how long, is your decision and not this tool’s.',
      );
    }

    writeFileSync(
      options.metadata,
      `${toJson(meshArtMetadata(facts, { image: options.imageUri, style }))}
`,
    );
    console.log(render.dim(`Metadata: ${options.metadata}`));
  }
}


/**
 * `checkpay` — whether an invoice you were handed can be paid at all.
 *
 * Exits non-zero when it cannot, so it drops into a script that refuses to sign
 * rather than into a human's judgement. That is the point of having it here:
 * the demand usually arrives in an automated flow, and the check is only worth
 * anything if it can stop one.
 *
 * `--json` prints the whole report, which is what a caller that wants to log
 * the reason alongside the refusal should use.
 */
program
  .command('checkpay')
  .description('Before signing: whether a payment demand can actually be paid.')
  .option('--to <address>', 'The wallet the demand says will be paid.')
  .option('--token-account <address>', 'The exact destination token account the demand names.')
  .option('--mint <address>', 'Token address — the mint on Solana. Omit for the native asset.')
  .option('--token <address>', 'Alias for --mint, for EVM chains where the token is a contract.')
  .option('--asset <symbol>', 'The ticker the demand claims, e.g. USDC. Checked against --mint.')
  .option('--amount <amount>', 'Whole tokens, as the demand displays it.')
  .option('--base-units <amount>', 'The same amount in base units, where the demand states both.')
  .option('--decimals <n>', 'The decimals the demand assumes.', (v: string) => Number(v))
  .option('--memo <text>', 'Text the demand says the payment must carry.')
  .option('--reference <pubkey>', 'The Solana Pay reference the demand names.')
  .option('--expires-at <iso>', 'When the demand stops being valid.')
  .option('-c, --chain <chain>', 'Chain id or alias, EVM or Solana. Defaults to "solana".')
  .action(
    async (options: {
      to?: string;
      tokenAccount?: string;
      mint?: string;
      token?: string;
      asset?: string;
      amount?: string;
      baseUnits?: string;
      decimals?: number;
      memo?: string;
      reference?: string;
      expiresAt?: string;
      chain?: string;
    }) => {
      const report = await ops.inspectPayment({
        ...(options.to ? { to: options.to } : {}),
        ...(options.tokenAccount ? { tokenAccount: options.tokenAccount } : {}),
        ...(options.mint ? { mint: options.mint } : {}),
        ...(options.token ? { token: options.token } : {}),
        ...(options.asset ? { asset: options.asset } : {}),
        ...(options.amount ? { amount: options.amount } : {}),
        ...(options.baseUnits ? { amountBaseUnits: options.baseUnits } : {}),
        ...(options.decimals !== undefined ? { decimals: options.decimals } : {}),
        ...(options.memo ? { memo: options.memo } : {}),
        ...(options.reference ? { reference: options.reference } : {}),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        ...(options.chain ? { chain: options.chain } : {}),
      });

      if (program.opts().json) {
        console.log(toJson(report));
      } else {
        console.log(render.heading('Payment check'));
        console.log(render.renderPaymentDemand(report));
        console.log();
        console.log(`  ${report.note}`);
      }

      // Non-zero on anything that is not a clean bill of health. `unproven` is
      // deliberately non-zero too: a script that treats "I could not check" as
      // "go ahead" is the failure this whole command exists to prevent.
      process.exitCode = report.verdict === 'payable' ? 0 : 1;
    },
  );

/**
 * `paydemand` — check an invoice, then build the payment if it survives.
 *
 * The paying half of `checkpay`. Exits non-zero and builds nothing when the
 * demand does not check out, so a script can pipe straight from this into a
 * signer and never reach one for a demand that was wrong.
 */
program
  .command('paydemand')
  .description('Check a payment demand, then build the unsigned payment for it.')
  .requiredOption('--from <address>', 'The wallet that will pay, and sign.')
  .option('--to <address>', 'The wallet the demand says will be paid.')
  .option('--token-account <address>', 'The exact destination token account the demand names.')
  .option('--mint <address>', 'Token address — the mint on Solana. Omit for the native asset.')
  .option('--token <address>', 'Alias for --mint, for EVM chains where the token is a contract.')
  .option('--asset <symbol>', 'The ticker the demand claims. Checked against the token address.')
  .option('--amount <amount>', 'Whole tokens, as the demand displays it.')
  .option('--base-units <amount>', 'The same amount in base units, where the demand states both.')
  .option('--decimals <n>', 'The decimals the demand assumes.', (v: string) => Number(v))
  .option('--memo <text>', 'Text the demand says the payment must carry.')
  .option('--reference <pubkey>', 'The Solana Pay reference the demand names.')
  .option('--expires-at <iso>', 'When the demand stops being valid.')
  .option('-c, --chain <chain>', 'Chain id or alias, EVM or Solana. Defaults to "solana".')
  .action(
    async (options: {
      from: string;
      to?: string;
      tokenAccount?: string;
      mint?: string;
      token?: string;
      asset?: string;
      amount?: string;
      baseUnits?: string;
      decimals?: number;
      memo?: string;
      reference?: string;
      expiresAt?: string;
      chain?: string;
    }) => {
      const { report, transaction } = await ops.payDemand({
        from: options.from,
        ...(options.to ? { to: options.to } : {}),
        ...(options.tokenAccount ? { tokenAccount: options.tokenAccount } : {}),
        ...(options.mint ? { mint: options.mint } : {}),
        ...(options.token ? { token: options.token } : {}),
        ...(options.asset ? { asset: options.asset } : {}),
        ...(options.amount ? { amount: options.amount } : {}),
        ...(options.baseUnits ? { amountBaseUnits: options.baseUnits } : {}),
        ...(options.decimals !== undefined ? { decimals: options.decimals } : {}),
        ...(options.memo ? { memo: options.memo } : {}),
        ...(options.reference ? { reference: options.reference } : {}),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        ...(options.chain ? { chain: options.chain } : {}),
      });

      if (program.opts().json) {
        console.log(toJson({ report, transaction }));
        return;
      }

      console.log(render.heading('Payment check'));
      console.log(render.renderPaymentDemand(report));
      console.log(render.heading('Unsigned transaction'));
      console.log(render.renderUnsignedTx(transaction));
    },
  );

/**
 * `provepay` — after paying, prove the payment met the demand.
 *
 * The other end of `paydemand`. Exits non-zero on anything short of `proven`,
 * so a script cannot read a merely-landed payment as a credited one.
 */
program
  .command('provepay <signature>')
  .description('Prove from the chain that a payment you made met the demand.')
  .requiredOption('--to <address>', 'The wallet the demand said would be paid.')
  .requiredOption('--amount <amount>', 'Whole tokens, as the demand stated it.')
  .option('--mint <address>', 'Token address — the mint. Omit for native SOL.')
  .option('--token-account <address>', 'The exact destination token account the demand named.')
  .option('--memo <text>', 'Text the demand said the payment must carry.')
  .option('--expires-at <iso>', 'When the demand stopped being valid.')
  .option('--from <address>', 'The wallet that should have paid.')
  .option('-c, --chain <chain>', 'Solana chain id or alias. Defaults to "solana".')
  .action(
    async (
      signature: string,
      options: {
        to: string;
        amount: string;
        mint?: string;
        tokenAccount?: string;
        memo?: string;
        expiresAt?: string;
        from?: string;
        chain?: string;
      },
    ) => {
      const proof = await ops.provePayment({
        signature,
        to: options.to,
        amount: options.amount,
        ...(options.mint ? { mint: options.mint } : {}),
        ...(options.tokenAccount ? { tokenAccount: options.tokenAccount } : {}),
        ...(options.memo ? { memo: options.memo } : {}),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        ...(options.from ? { from: options.from } : {}),
        ...(options.chain ? { chain: options.chain } : {}),
      });

      process.exitCode = proof.verdict === 'proven' ? 0 : 1;

      if (program.opts().json) {
        console.log(toJson(proof));
        return;
      }

      console.log(render.heading('Payment proof'));
      console.log(render.renderPaymentProof(proof));
    },
  );

/**
 * `pay` — create a payment request somebody can scan.
 *
 * The whole loop from a terminal: name an amount and a recipient, get a QR in
 * the scrollback, let somebody point a phone at it, then ask whether it landed.
 * Nothing here signs, and nothing here can: the QR is a link, the wallet builds
 * and shows the transaction, and the person holding the phone decides.
 *
 * Recipients are checked against `SINGULARITY_PAY_RECIPIENTS` for the reason in
 * `pay/file-store.ts` — a command that builds a payment request to whatever
 * address it is handed is a way to get somebody else paid under your name.
 */
const payCommand = program
  .command('pay')
  .description('Create a payment request, and check whether it was paid.')
  .addHelpText(
    'after',
    `
  Solana only. The request is a Solana Pay transaction request: the wallet
  fetches it, builds the transaction, and shows the payer what they are
  approving. Singularity holds no keys and never signs.

  Set SINGULARITY_PAY_ENDPOINT to the public URL of your /i/ endpoint, and
  SINGULARITY_PAY_RECIPIENTS to the addresses you will accept payment at.

  Examples:
    singularity pay new 25 --to <address> --token <mint> --label "Order 7"
    singularity pay status <intent-id>
    singularity pay list`,
  );

/** The store every `pay` subcommand shares. */
function payStore(): FileIntentStore {
  return new FileIntentStore();
}

/** The endpoint links are built against, refusing rather than guessing. */
function payEndpoint(): string {
  // Not SINGULARITY_PAY_ENDPOINT: that predates this and points at /api/burn.
  // Two routes doing two things need two variables, or whichever was set last
  // silently breaks the other.
  const endpoint = process.env.SINGULARITY_PAYMENT_ENDPOINT?.trim();

  if (!endpoint) {
    throw new SingularityError(
      'NO_PAY_ENDPOINT',
      'SINGULARITY_PAYMENT_ENDPOINT is not set, so there is nowhere for a wallet to fetch the request from.',
      'Set it to the public URL of your deployed /api/pay route, e.g. https://pay.example.com/api/pay. Note it is not SINGULARITY_PAY_ENDPOINT, which names the burn route.',
    );
  }

  return endpoint;
}

payCommand
  .command('new')
  .description('Create a payment request and print it as a QR code.')
  .argument('<amount>', 'Whole tokens as a decimal string, never base units.')
  .requiredOption('--to <address>', 'Who gets paid. Must be a configured recipient.')
  .option('--token <mint>', 'Mint address. Omit for native SOL. Never a ticker.')
  .option('--label <text>', 'What the wallet shows as the payee.')
  .option('--memo <text>', 'Text the payment must carry, bound at creation.')
  .option('--order <id>', 'Your own order id, carried through settlement.')
  .option('--expires <seconds>', 'How long the request stays presentable. Default 900.')
  .option('--sender <address>', 'Check this wallet can actually pay before publishing the request.')
  .option('--no-telegram', 'Do not send the QR to Telegram, even if a chat is configured.')
  .action(
    async (
      amount: string,
      options: {
        to: string;
        token?: string;
        label?: string;
        memo?: string;
        order?: string;
        expires?: string;
        sender?: string;
        telegram: boolean;
      },
    ) => {
      requireAllowedRecipient(options.to);

      const created = await createPayIntent(payStore(), payEndpoint(), {
        to: options.to,
        amount,
        ...(options.token ? { mint: options.token } : {}),
        ...(options.label ? { label: options.label } : {}),
        ...(options.memo ? { memo: options.memo } : {}),
        ...(options.order ? { orderId: options.order } : {}),
        ...(options.expires ? { expiresIn: Number(options.expires) } : {}),
      });

      // The same code goes to the phone. Not a regenerated one: one intent,
      // one URL, one matrix, rendered twice. A terminal QR and a Telegram QR
      // that could differ would be two chances to be wrong and no way to tell
      // which. Off with --no-telegram, and silent about it when no chat is
      // configured, because that is the ordinary case rather than a fault.
      const notified = options.telegram ? await notifyPayment(created) : undefined;

      if (program.opts().json) {
        console.log(toJson({ ...created, telegram: notified }));
        return;
      }

      console.log(render.heading(`Payment request — ${created.intent.label}`));
      console.log('');
      console.log(qrUnicode(qrMatrix(created.url, { margin: 2 })));
      console.log(`  ${created.url}`);
      console.log('');
      console.log(render.renderIntent(created));

      // A transfer request has no sender field — the payer is whoever scans it
      // — so a named one is only worth anything as a check. Reading the balance
      // is the check that matters: building the transfer catches a missing
      // token account but constructs a native SOL transfer without ever looking
      // at what the wallet holds.
      if (options.sender) {
        const held = await ops
          .getBalance({
            address: options.sender,
            chain: created.intent.chain,
            includeTokens: Boolean(options.token),
            ...(options.token ? { tokens: [options.token] } : {}),
          })
          .catch(() => null);

        const balance = held
          ? options.token
            ? held.tokens.find((entry) => entry.token?.address === options.token)?.amount
            : held.native.amount
          : undefined;

        console.log('');
        if (!balance) {
          console.log(`  ${render.yellow('sender')}  ${render.dim(`${options.sender} — balance unreadable, or no account for this token`)}`);
        } else if (Number(balance.formatted) < Number(amount)) {
          console.log(
            `  ${render.red('sender cannot pay')}  holds ${balance.formatted} ${balance.symbol}, needs ${amount}`,
          );
          process.exitCode = 1;
        } else {
          console.log(`  ${render.green('sender can pay')}  holds ${balance.formatted} ${balance.symbol}`);
        }
      }

      if (notified?.sent) {
        // Naming the bot, not just the chat: a stale TELEGRAM_BOT_TOKEN in the
        // environment sends successfully from the wrong bot, and that failure
        // is otherwise completely silent.
        console.log(
          `
  ${render.green('sent to Telegram')}  ${render.dim(
            `chat ${notified.chatId}${notified.sentAs ? ` as @${notified.sentAs}` : ''}`,
          )}`,
        );
      } else if (notified?.reason && process.env.TELEGRAM_BOT_TOKEN) {
        // Only worth saying when a bot exists and it still did not arrive. A
        // deployment with no bot configured is not failing at anything.
        console.log(`
  ${render.yellow('not sent to Telegram')}  ${render.dim(notified.reason)}`);
      }
    },
  );

payCommand
  .command('status')
  .description('Ask whether a payment request has been paid, and how settled it is.')
  .argument('<id>', 'The intent id, as `pay new` printed it.')
  .option('--require <level>', 'Settlement bar: pending, probabilistic, or final. Default final.')
  .option('--watch', 'Poll until it settles, then stop.')
  .option('-i, --interval <seconds>', 'Seconds between polls when watching. Default 10.')
  .action(async (id: string, options: { require?: string; watch?: boolean; interval?: string }) => {
    const store = payStore();
    const require_ = options.require as SettlementLevel | undefined;

    if (!options.watch) {
      const result = await settleIntent(store, id, require_ ? { require: require_ } : {});
      if (program.opts().json) console.log(toJson(result));
      else console.log(render.renderSettlement(result));

      // Non-zero until it is actually paid, so this drops into a script that
      // waits before shipping.
      process.exitCode = result.fulfil || result.alreadyFulfilled ? 0 : 1;
      return;
    }

    let settled = false;

    if (!program.opts().json) {
      console.log(render.heading(`Watching payment ${id}`));
      console.log(render.dim('  Polling. Ctrl-C to stop.\n'));
    }

    const subscription = pollLoop(
      async () => {
        const result = await settleIntent(store, id, require_ ? { require: require_ } : {});
        if (result.fulfil || result.alreadyFulfilled) settled = true;
        return result;
      },
      (result) => `${result.level}|${result.fulfil}|${result.mismatches.length}`,
      ({ value, at }) => {
        emitChange('payment', at, { id, level: value.level, fulfil: value.fulfil }, () =>
          render.renderSettlementLine(value),
        );
      },
      {
        intervalMs: intervalMs(options.interval, 10),
        until: () => settled,
        onError: watchError,
        label: 'singularity pay status',
      },
    );

    await runWatch(subscription);
    process.exitCode = settled ? 0 : 1;
  });

payCommand
  .command('list')
  .description('Every payment request this machine has created, newest first.')
  .option('-n, --limit <count>', 'How many to show. Default 20.')
  .action(async (options: { limit?: string }) => {
    const all = await payStore().all();
    const limit = options.limit ? Number(options.limit) : 20;
    const shown = all.slice(0, limit);

    if (program.opts().json) {
      console.log(toJson(shown));
      return;
    }

    if (shown.length === 0) {
      console.log(render.dim('\n  No payment requests yet. `singularity pay new` makes one.\n'));
      return;
    }

    console.log(render.heading('Payment requests'));
    console.log(render.renderIntentList(shown));

    if (all.length > shown.length) {
      console.log(render.dim(`\n  ${all.length - shown.length} older, not shown.`));
    }
  });

/**
 * `exchange` — buy a job on the PrivateDAO agent exchange.
 *
 * Two halves either side of a signature this CLI never makes: `buy` goes as far
 * as an unsigned payment and stops, `settle` picks up from the signature. What
 * signs in between is the payer's own wallet or script.
 */
const exchangeCommand = program
  .command('exchange')
  .description('Buy a job on the PrivateDAO agent exchange: quote, then settle.')
  .addHelpText(
    'after',
    `
  The payment in between is signed outside this CLI, which holds no keys.

  Examples:
    singularity exchange services
    singularity exchange buy token.intelligence --input '{"network":"solana-mainnet-beta","asset":"<mint>"}' --from <wallet>
    singularity exchange settle <job_id> <signature> --input '<the same json>'`,
  );

function parseInput(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Reported below with the same message as a non-object.
  }
  throw new SingularityError('BAD_INPUT', '--input must be a JSON object.', `Got: ${raw}`);
}

exchangeCommand
  .command('services')
  .description('What the exchange sells, and for how much.')
  .action(async () => {
    const services = await createExchange().services();

    if (program.opts().json) {
      console.log(toJson(services));
      return;
    }

    console.log(render.heading('PrivateDAO services'));
    console.log(
      render.table(
        services.map((service) => [
          service.id,
          service.price ? `${service.price} ${service.currency}` : render.green('free'),
          render.dim(service.title),
        ]),
        ['SERVICE', 'PRICE', ''],
      ),
    );
  });

exchangeCommand
  .command('buy <service>')
  .description('Open a job, check its payment demand, and build the unsigned payment.')
  .requiredOption('--from <address>', 'The wallet that will pay, and sign.')
  .option('--input <json>', 'The service input, as a JSON object.')
  .action(async (service: string, options: { from: string; input?: string }) => {
    const input = parseInput(options.input);
    const quote = await quoteJob(createExchange(), {
      service,
      from: options.from,
      ...(input ? { input } : {}),
    });

    if (program.opts().json) {
      console.log(toJson(quote));
      return;
    }

    if (quote.kind === 'free') {
      console.log(render.heading('Free job'));
      console.log(toJson(quote.job));
      return;
    }

    console.log(render.heading(`Job ${quote.jobId}`));
    console.log(render.renderPaymentDemand(quote.report));
    console.log(render.heading('Unsigned payment'));
    console.log(render.renderUnsignedTx(quote.transaction));
    console.log(
      `\n  ${render.dim('Sign it within about a minute, then:')}\n  singularity exchange settle ${quote.jobId} <signature>` +
        (options.input ? ` --input '${options.input}'` : ''),
    );
  });

exchangeCommand
  .command('settle <jobId> <signature>')
  .description('Prove the payment, submit it, wait for the credit, and verify the receipt.')
  .option('--input <json>', 'The input the job was created with, to re-derive the receipt.')
  .option('--wait <seconds>', 'How long to wait for finality, then for the job. Default 90.', (v: string) => Number(v))
  .action(async (jobId: string, signature: string, options: { input?: string; wait?: number }) => {
    const input = parseInput(options.input);
    const settlement = await settleJob(createExchange(), {
      jobId,
      signature,
      ...(input ? { input } : {}),
      ...(options.wait !== undefined ? { waitMs: options.wait * 1000 } : {}),
    });

    // Only a verified job exits 0: a script reading "credited" as done would be
    // trusting a receipt nobody checked.
    process.exitCode = settlement.verdict === 'verified' ? 0 : 1;

    if (program.opts().json) {
      console.log(toJson(settlement));
      return;
    }

    console.log(render.heading('Settlement'));
    console.log(render.renderJobSettlement(settlement));
    console.log(render.heading('Payment proof'));
    console.log(render.renderPaymentProof(settlement.proof));
  });

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
