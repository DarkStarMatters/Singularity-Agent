/**
 * The moves available to the mesh, and what each one is worth trying for.
 *
 * A move is one tool in the catalogue, plus the three things a search needs
 * that a tool definition does not carry: what has to be known before it can be
 * called at all, what it proves when it answers, and roughly what it costs to
 * find out. None of that is guessable from a tool's description, and all three
 * are properties of the tool rather than of any particular run — so they are
 * declared here, once, next to each other, where a wrong one is visible.
 *
 * The moves do not call anything. `search.ts` is handed a runner and invokes
 * tools through it, which keeps this file free of a dependency on
 * `operations.ts` — the module that will own the mesh tool itself — and, more
 * usefully, makes the whole search runnable against a fake runner with no
 * network at all. A search whose tests need live RPCs is a search nobody
 * tests.
 */
import { getChain } from '../core/registry.js';
import type { Blackboard, FactKind } from './blackboard.js';

/** What the caller asked for, carried alongside the board. */
export interface MeshContext {
  subject: string;
  /** The chain the caller named, if any. Never inferred into this field. */
  chainHint?: string;
  objective: Objective;
  budget?: unknown;
}

export interface Move {
  /** The catalogue tool this move calls. Also its name in the trace. */
  tool: string;
  /** Facts that must already be proved. */
  needs: FactKind[];
  /** Facts this move can prove. Never a promise that it will. */
  binds: FactKind[];
  /**
   * Round trips this move implies, roughly.
   *
   * The search's `g`. Not latency and not a price — a count of how much work
   * the move asks of the endpoints, so that two moves which would prove the
   * same slot are ordered by what they cost rather than by declaration order.
   * `chain_liveness` probes every endpoint a chain has; `inspect_exit` reads a
   * mint and then its largest holders. Those are genuinely not one call.
   */
  cost: number;
  /** A gate beyond `needs` — usually "this only exists on Solana". */
  gate?(board: Blackboard, ctx: MeshContext): boolean;
  /** Why the gate refused, for the trace. Read only when `gate` returns false. */
  gateNote?: string;
  args(board: Blackboard, ctx: MeshContext): Record<string, unknown>;
  /** Record what the result proves. Returns the slots this call was first to fill. */
  bind(board: Blackboard, result: unknown, ctx: MeshContext): FactKind[];
}

export type Objective = 'identify' | 'holdings' | 'activity' | 'settlement' | 'safety' | 'liveness';

/**
 * What each objective counts as an answer.
 *
 * This is the search's `h`: the number of these still missing is how far the
 * mesh believes it is from done. Keeping them explicit is what stops the run
 * being open-ended — a mesh with no stated goal has no way to know it has
 * finished, and would spend its whole budget every time.
 */
export const OBJECTIVES: Record<Objective, FactKind[]> = {
  identify: ['subjectKind', 'chain'],
  holdings: ['subjectKind', 'chain', 'nativeBalance', 'tokens'],
  activity: ['subjectKind', 'chain', 'activity'],
  settlement: ['subjectKind', 'chain', 'txSummary', 'finality'],
  safety: ['subjectKind', 'chain', 'authorities', 'identity', 'exit'],
  liveness: ['chain', 'liveness', 'fees'],
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** The family of the chain currently on the board, where one is known. */
function familyOnBoard(board: Blackboard): string | undefined {
  const chain = board.value<string>('chain');
  if (!chain) return undefined;
  try {
    return getChain(chain).family;
  } catch {
    return undefined;
  }
}

const onSolana = (board: Blackboard): boolean => familyOnBoard(board) === 'svm';

const SOLANA_ONLY =
  'Mint accounts, their authorities and their transfer rules are Solana concepts; this move has nothing to read on another family.';

export const MOVES: Move[] = [
  {
    tool: 'resolve',
    needs: [],
    binds: ['subjectKind', 'chain', 'address', 'txHash', 'mint'],
    cost: 1,
    args: (_board, ctx) => ({
      input: ctx.subject,
      ...(ctx.chainHint ? { chain: ctx.chainHint } : {}),
    }),
    bind: (board, result, ctx) => {
      const identity = record(result);
      const bound: FactKind[] = [];

      const kind = text(identity.kind) ?? 'unknown';
      if (
        board.bind(
          'subjectKind',
          { kind, note: text(identity.note), alias: text(identity.alias) },
          'resolve',
        )
      ) {
        bound.push('subjectKind');
      }

      const chains = Array.isArray(identity.chains) ? identity.chains : [];
      const chain = ctx.chainHint ?? text(chains[0]);
      if (chain && board.bind('chain', chain, 'resolve')) bound.push('chain');

      const address = text(identity.address);
      if (address && board.bind('address', address, 'resolve')) bound.push('address');

      if (kind === 'tx' && board.bind('txHash', ctx.subject.trim(), 'resolve')) {
        bound.push('txHash');
      }

      // A Solana mint and a Solana wallet are both 32 bytes of base58 and
      // nothing about the string tells them apart — the distinction lives in
      // the account, which has not been read yet. So this is not an inference
      // from the chain; it is the caller's own assertion, made by asking for
      // the safety objective at all, written down as such. If the assertion is
      // wrong, mint_audit fails against it, and that failure is a better
      // answer than a guess would have been.
      if (
        ctx.objective === 'safety' &&
        address &&
        familyOnBoard(board) === 'svm' &&
        board.bind(
          'mint',
          {
            address,
            assumed: true,
            note: 'Treated as a mint because the objective is `safety`. Nothing read so far distinguishes a mint from a wallet at this address.',
          },
          'resolve',
        )
      ) {
        bound.push('mint');
      }

      return bound;
    },
  },

  {
    tool: 'chain_liveness',
    needs: ['chain'],
    binds: ['liveness'],
    cost: 2,
    args: (board) => ({ chain: [board.value<string>('chain')] }),
    bind: (board, result) => {
      const entry = record(Array.isArray(result) ? result[0] : result);
      if (!text(entry.status)) return [];

      return board.bind(
        'liveness',
        {
          status: entry.status,
          height: entry.height,
          ageSeconds: entry.ageSeconds,
          answering: entry.answering,
          configured: entry.configured,
        },
        'chain_liveness',
      )
        ? ['liveness']
        : [];
    },
  },

  {
    tool: 'fees',
    needs: ['chain'],
    binds: ['fees'],
    cost: 1,
    args: (board) => ({ chain: board.value<string>('chain') }),
    bind: (board, result) => {
      const estimate = record(result);
      const transfer = record(estimate.simpleTransfer);
      const details = record(estimate.details);

      // An endpoint that answered with nothing useful has not established what
      // a transfer costs, and filling the slot from it would put a fact on the
      // board that no caller could act on.
      if (!text(transfer.formatted) && Object.keys(details).length === 0) return [];

      return board.bind(
        'fees',
        {
          simpleTransfer: text(transfer.formatted),
          knobs: Object.keys(details),
        },
        'fees',
      )
        ? ['fees']
        : [];
    },
  },

  {
    tool: 'balance',
    needs: ['address', 'chain'],
    binds: ['nativeBalance', 'tokens'],
    cost: 2,
    args: (board, ctx) => ({
      address: board.value<string>('address'),
      chain: board.value<string>('chain'),
      ...(ctx.budget !== undefined ? { budget: ctx.budget } : {}),
    }),
    bind: (board, result) => {
      const balance = record(result);
      const native = record(balance.native);
      const amount = record(native.amount);
      const bound: FactKind[] = [];

      if (
        board.bind(
          'nativeBalance',
          { symbol: text(amount.symbol) ?? text(native.symbol), formatted: text(amount.formatted) },
          'balance',
        )
      ) {
        bound.push('nativeBalance');
      }

      const tokens = Array.isArray(balance.tokens) ? balance.tokens : [];
      const scan = record(balance.tokenCompleteness);
      if (
        board.bind(
          'tokens',
          {
            count: tokens.length,
            // The count and the kind travel together. A count on its own is
            // the exact shape of the bug this repository keeps finding.
            completeness: text(scan.kind) ?? 'unknown',
            note: text(scan.note),
          },
          'balance',
        )
      ) {
        bound.push('tokens');
      }

      return bound;
    },
  },

  {
    tool: 'history',
    needs: ['address', 'chain'],
    binds: ['activity'],
    cost: 2,
    args: (board, ctx) => ({
      address: board.value<string>('address'),
      chain: board.value<string>('chain'),
      ...(ctx.budget !== undefined ? { budget: ctx.budget } : {}),
    }),
    bind: (board, result) => {
      const history = record(result);
      const entries = Array.isArray(history.entries) ? history.entries : [];
      const scan = record(history.completeness);

      // An empty list from a failed scan is not activity anybody may reason
      // about, so it does not get to fill the slot. Leaving it unproved is
      // what puts it in `unproven` with a reason instead.
      if (entries.length === 0 && text(scan.kind) === 'failed') return [];

      return board.bind(
        'activity',
        {
          entries: entries.length,
          completeness: text(scan.kind) ?? 'unknown',
          note: text(scan.note),
          morePages: Boolean(text(history.cursor)),
        },
        'history',
      )
        ? ['activity']
        : [];
    },
  },

  {
    tool: 'transaction',
    needs: ['txHash'],
    binds: ['txSummary', 'finality', 'chain'],
    cost: 2,
    args: (board, ctx) => ({
      hash: board.value<string>('txHash'),
      ...(ctx.chainHint ? { chain: ctx.chainHint } : {}),
    }),
    bind: (board, result) => {
      const search = record(result);
      const found = Array.isArray(search.found) ? search.found : [];
      const tx = record(found[0]);
      if (!text(tx.hash)) return [];

      const bound: FactKind[] = [];
      const chain = text(tx.chain);
      if (chain && board.bind('chain', chain, 'transaction')) bound.push('chain');

      if (
        board.bind(
          'txSummary',
          {
            chain,
            status: text(tx.status),
            blockNumber: tx.blockNumber,
            summary: text(tx.summary),
          },
          'transaction',
        )
      ) {
        bound.push('txSummary');
      }

      const finality = record(tx.finality);
      if (
        text(finality.kind) &&
        board.bind(
          'finality',
          { kind: finality.kind, confirmations: finality.confirmations, note: text(finality.note) },
          'transaction',
        )
      ) {
        bound.push('finality');
      }

      return bound;
    },
  },

  {
    tool: 'mint_audit',
    needs: ['mint', 'chain'],
    binds: ['authorities'],
    cost: 1,
    gate: onSolana,
    gateNote: SOLANA_ONLY,
    args: (board) => ({
      mint: board.value<Record<string, unknown>>('mint')?.address,
      chain: board.value<string>('chain'),
    }),
    bind: (board, result) => {
      const audit = record(result);
      if (!text(audit.mint)) return [];

      return board.bind(
        'authorities',
        {
          program: audit.program,
          decimals: audit.decimals,
          mintAuthority: audit.mintAuthority ?? null,
          freezeAuthority: audit.freezeAuthority ?? null,
          extensions: Array.isArray(audit.extensions) ? audit.extensions.length : 0,
        },
        'mint_audit',
      )
        ? ['authorities']
        : [];
    },
  },

  {
    tool: 'token_identity',
    needs: ['mint', 'chain'],
    binds: ['identity'],
    cost: 2,
    gate: onSolana,
    gateNote: SOLANA_ONLY,
    args: (board) => ({
      mint: board.value<Record<string, unknown>>('mint')?.address,
      chain: board.value<string>('chain'),
    }),
    bind: (board, result) => {
      const identity = record(result);
      if (!text(identity.mint)) return [];

      const immutable = record(identity.immutable);
      return board.bind(
        'identity',
        {
          // Both of these were authored by whoever deployed the mint. They
          // travel exactly as the tool returned them, mark included, so
          // nothing downstream can mistake them for something this wrote.
          symbol: identity.symbol,
          name: identity.name,
          metadata: immutable.metadata,
          documentAnchored: immutable.document,
        },
        'token_identity',
      )
        ? ['identity']
        : [];
    },
  },

  {
    tool: 'inspect_exit',
    needs: ['mint', 'chain'],
    binds: ['exit'],
    cost: 3,
    gate: onSolana,
    gateNote: SOLANA_ONLY,
    args: (board) => ({
      mint: board.value<Record<string, unknown>>('mint')?.address,
      chain: board.value<string>('chain'),
    }),
    bind: (board, result) => {
      const report = record(result);
      if (typeof report.canExit !== 'boolean') return [];

      const risks = Array.isArray(report.risks) ? report.risks : [];
      return board.bind(
        'exit',
        {
          canExit: report.canExit,
          underThirdPartyControl: report.underThirdPartyControl,
          risks: risks.length,
          mechanisms: risks.map((risk) => text(record(risk).kind)).filter(Boolean),
        },
        'inspect_exit',
      )
        ? ['exit']
        : [];
    },
  },
];

export const MOVES_BY_TOOL = new Map(MOVES.map((move) => [move.tool, move]));
