/**
 * Q*3e(σ) — a best-first search over tool calls, supervised step by step.
 *
 * ## What the name is short for, so it stops being mystique
 *
 * **Q\*** is the pairing the reasoning-model literature is built on: a value
 * estimate over actions, driven by an A*-style frontier rather than by taking
 * the next step greedily. Here the actions are tool calls, `g` is what has
 * been spent in round trips, `h` is how many of the objective's facts are
 * still missing, and the frontier is ordered by `f = g + h`. That is A*, over
 * a state space made of evidence.
 *
 * **3e** is the three echelons each wave passes through, which is where the
 * step-by-step part lives:
 *
 * 1. *Expand* — enumerate the moves that are applicable right now. A move is
 *    applicable when everything it needs is already proved and it could still
 *    prove something missing. Nothing speculative is enumerated, so the
 *    frontier never contains a call that cannot be made.
 * 2. *Evaluate* — run the best few concurrently and score each one against
 *    the evidence it returned, not against how good it looked. `reward.ts`
 *    owns that arithmetic.
 * 3. *Elect* — keep the steps that paid, discard the ones that did not with
 *    the reason recorded, and let the next wave re-expand from a board that
 *    has moved. A wave that elects nothing is a backtrack: the frontier is
 *    rebuilt without the moves that just failed, and the next-best are tried.
 *
 * **σ** is the summed process reward over the run, reported against what the
 * same number of calls could have earned. It is the one number that says
 * whether the search got its money's worth.
 *
 * ## What this is not
 *
 * It does not think. There is no language model anywhere in this file, no
 * policy that was trained, and nothing here has an opinion. A "tree of
 * thoughts" is a tree of *reasoning steps* scored by a model that judges
 * reasoning; this is a tree of *reads* scored by what the chain returned. The
 * distinction is the entire reason the trace is worth showing somebody: two
 * runs against the same chain state produce the same rewards and the same
 * path, and any step in it can be re-run by hand from the arguments recorded
 * beside it.
 *
 * What it buys, then, is narrow and real. A model asking "is this token safe
 * to buy" issues four calls in some order, forgets which ones it already made,
 * and has no way to state afterwards which parts of its answer were proved. A
 * mesh run issues those calls in a cost-ordered wave, never pays for the same
 * fact twice, and comes back with the facts, the path, and — the part that
 * matters most — an explicit list of what it could not prove and why.
 */
import { SingularityError } from '../core/errors.js';
import {
  UNTRUSTED_NOTE,
  carriesUntrusted,
  completeness,
  findCompleteness,
  weakest,
  type Completeness,
} from '../core/envelope.js';
import { getChain } from '../core/registry.js';
import { Blackboard, type FactKind } from './blackboard.js';
import { MOVES, OBJECTIVES, type MeshContext, type Move, type Objective } from './moves.js';
import { MAX_STEP_REWARD, scoreStep, sigma, type Sigma, type StepReward } from './reward.js';

/**
 * How a move actually gets called.
 *
 * Injected rather than imported, for two reasons that both matter. The tool
 * catalogue imports the operations layer and the operations layer will own the
 * mesh, so importing back would close a cycle. And a search that can only run
 * against live endpoints is a search whose ordering, pruning and backtracking
 * are untestable — every one of which is a behaviour worth a test.
 */
export type ToolRunner = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface MeshRequest {
  subject: string;
  objective: Objective;
  chain?: string;
  /** Hard ceiling on tool calls. The only knob that spends anything. */
  maxCalls?: number;
  /** How many moves may run concurrently in one wave. */
  beam?: number;
  budget?: unknown;
  /** Rank the moves and return the order without calling anything. */
  plan?: boolean;
}

export interface MeshStep {
  wave: number;
  tool: string;
  /** Exactly what was passed, so any step can be re-run by hand. */
  args: Record<string, unknown>;
  /** The frontier arithmetic that chose this move over the alternatives. */
  rank: { g: number; h: number; f: number };
  proved: FactKind[];
  reward: StepReward;
  /** False when the step did not clear the prune floor. */
  kept: boolean;
  completeness?: Completeness;
  /** Present when the result carried text somebody on the chain wrote. */
  untrusted?: true;
  error?: { code: string; message: string; hint?: string };
}

export interface PlannedStep {
  wave: number;
  tool: string;
  rank: { g: number; h: number; f: number };
  wouldProve: FactKind[];
  /** True when a gate could not be evaluated because the chain is not yet known. */
  conditional?: true;
}

export interface Unproven {
  fact: FactKind;
  why: string;
}

export interface MeshResult {
  objective: Objective;
  subject: string;
  chain?: string;
  /**
   * `answered` only when every fact the objective asked for was proved.
   *
   * `partial` and `unanswerable` are not degrees of failure, they are
   * different statements: `partial` means some of the answer is evidence and
   * the rest is named in `unproven`; `unanswerable` means nothing the
   * objective wanted could be established from this subject at all.
   */
  verdict: 'answered' | 'partial' | 'unanswerable' | 'planned';
  waves: number;
  calls: number;
  /** Why the search stopped, in one clause. */
  stopped: string;
  /** How many waves elected nothing and had to rebuild the frontier. */
  backtracks: number;
  path: MeshStep[];
  discarded: MeshStep[];
  plan?: PlannedStep[];
  facts: Record<string, { value: unknown; source: string }>;
  sigma: Sigma;
  unproven: Unproven[];
  completeness: Completeness;
  notes: string[];
}

const DEFAULT_MAX_CALLS = 8;
const CALL_CEILING = 16;
const DEFAULT_BEAM = 3;
const BEAM_CEILING = 5;

/** What an errored step adds to `g` on top of its cost. */
const FAILURE_PENALTY = 2;

function clamp(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), ceiling));
}

interface Candidate {
  move: Move;
  rank: { g: number; h: number; f: number };
  /** Goal slots this move could fill, if it answers. */
  wouldProve: FactKind[];
  conditional?: true;
}

/**
 * Echelon one — everything callable right now, ordered by `f = g + h`.
 *
 * `h` counts the goal facts that would still be missing *after* this move
 * proved everything it claims it can. That is admissible for any goal the mesh
 * can reach, since each remaining slot needs at least one more call; it is
 * deliberately not admissible for a slot nothing can reach, because there the
 * right behaviour is to stop looking rather than to search forever. Those
 * slots come back in `unproven` with the reason attached.
 */
function expand(
  board: Blackboard,
  ctx: MeshContext,
  goal: FactKind[],
  executed: Set<string>,
  spent: number,
  planning: boolean,
): Candidate[] {
  const missing = new Set(board.missing(goal));
  const candidates: Candidate[] = [];

  for (const move of MOVES) {
    if (executed.has(move.tool)) continue;
    if (!move.needs.every((need) => board.has(need))) continue;

    // A move has to contribute to the objective to be worth a call. Binding
    // *something* is not enough: `history` can always prove activity, and on
    // a holdings question that is a round trip spent on a fact nobody asked
    // for. This is the whole reason objectives are declared — without it the
    // mesh is a crawler.
    const wouldProve = move.binds.filter((slot) => missing.has(slot));
    if (wouldProve.length === 0) continue;

    let conditional: true | undefined;
    if (move.gate && !move.gate(board, ctx)) {
      // While planning with no chain named, a family gate has nothing to read
      // and refusing on that basis would hide a move the real run may well
      // make. It is included and marked instead.
      if (planning && !ctx.chainHint) conditional = true;
      else continue;
    }

    const h = [...missing].filter((slot) => !move.binds.includes(slot)).length;
    const g = spent + move.cost;

    candidates.push({
      move,
      rank: { g, h, f: g + h },
      wouldProve,
      ...(conditional ? { conditional } : {}),
    });
  }

  // Ties break on cost, then on declaration order — which puts `resolve`
  // first, where it belongs, without that being a special case in the code.
  return candidates.sort((a, b) => a.rank.f - b.rank.f || a.move.cost - b.move.cost);
}

function errorOf(err: unknown): { code: string; message: string; hint?: string } {
  if (err instanceof SingularityError) {
    return { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  }
  return { code: 'UNEXPECTED', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Seed the board with what the caller already told us.
 *
 * A chain the caller named is checked against the registry and marked
 * `input`, never `resolve` — the difference between "this chain exists" and
 * "this subject can exist on this chain" is exactly the sort of thing that
 * should not be quietly upgraded.
 */
function seed(board: Blackboard, request: MeshRequest): string[] {
  const notes: string[] = [];

  if (request.chain) {
    board.bind('chain', getChain(request.chain).id, 'input');
    return notes;
  }

  // `liveness` is the one objective whose subject is a chain rather than an
  // account, so the subject itself is the chain reference.
  if (request.objective === 'liveness') {
    try {
      board.bind('chain', getChain(request.subject).id, 'input');
    } catch {
      notes.push(
        `"${request.subject}" is not a chain this build knows, so the liveness objective has nothing to probe. Pass \`chain\`, or call \`chains\` for the list.`,
      );
    }
  }

  return notes;
}

/** Why a goal slot was never filled, named as specifically as the run allows. */
function explainUnproven(
  fact: FactKind,
  board: Blackboard,
  ctx: MeshContext,
  steps: MeshStep[],
  budgetSpent: boolean,
): string {
  const provers = MOVES.filter((move) => move.binds.includes(fact));
  if (provers.length === 0) return 'No move in the mesh proves this.';

  const reasons: string[] = [];
  for (const move of provers) {
    const step = steps.find((entry) => entry.tool === move.tool);
    if (step?.error) {
      reasons.push(`${move.tool} was called and failed: ${step.error.message}`);
      continue;
    }
    if (step) {
      // Where the source said why it could not answer, that sentence is the
      // reason — not a restatement of the fact that it did not. `history` on
      // an EVM chain with no indexer key says exactly what is missing and how
      // to supply it, and losing that here would turn a fixable gap into a
      // shrug.
      reasons.push(
        step.completeness?.kind === 'failed'
          ? `${move.tool} was called and could not answer: ${step.completeness.note}`
          : `${move.tool} was called and its answer did not establish this`,
      );
      continue;
    }
    if (move.gate && !move.gate(board, ctx)) {
      reasons.push(`${move.tool} does not apply here — ${move.gateNote ?? 'its gate refused'}`);
      continue;
    }
    const missing = move.needs.filter((need) => !board.has(need));
    if (missing.length > 0) {
      reasons.push(`${move.tool} needs ${missing.join(' and ')}, which was never proved`);
      continue;
    }
    reasons.push(
      budgetSpent
        ? `${move.tool} was applicable when the call budget ran out`
        : `${move.tool} was applicable and never reached`,
    );
  }

  return `${reasons.join('; ')}.`;
}

/**
 * What the whole run may claim about itself.
 *
 * The weakest completeness any step carried, downgraded when something the
 * objective asked for is missing. A run that read three exhaustive sources and
 * never reached the fourth is not exhaustive, and saying so is the difference
 * between a result somebody can act on and one that reads as settled.
 */
function composeCompleteness(
  steps: MeshStep[],
  goal: FactKind[],
  unproven: Unproven[],
): Completeness {
  const parts = steps.map((step) => step.completeness).filter((value): value is Completeness => Boolean(value));
  const worst = weakest(parts);

  if (unproven.length === 0) {
    return (
      worst ??
      completeness.exhaustive(
        `Every fact the ${goal.length}-part objective asked for was proved, and no source reported a limit on what it returned.`,
      )
    );
  }

  const names = unproven.map((entry) => entry.fact).join(', ');
  const note = `${goal.length - unproven.length} of ${goal.length} facts the objective asked for were proved. Never proved: ${names}. Each one is listed in \`unproven\` with the reason.${worst ? ` The sources that did answer were at best ${worst.kind}: ${worst.note}` : ''}`;

  return worst?.kind === 'failed' ? completeness.failed(note) : completeness.curated(note);
}

/**
 * Run the mesh.
 *
 * Call ordering inside a wave is deliberate and worth stating: the moves are
 * launched together, then their results are bound back in rank order once all
 * have settled. Binding as they land would make the board's contents depend on
 * which endpoint was fastest, and a search whose trace changes with network
 * weather is a search nobody can check.
 */
export async function runMesh(request: MeshRequest, runner: ToolRunner): Promise<MeshResult> {
  const subject = request.subject?.trim();
  if (!subject) {
    throw new SingularityError(
      'MESH_NO_SUBJECT',
      'A mesh run needs a subject — the address, transaction hash, name, mint or chain it is about.',
      'Pass `subject`. `objective` decides what is looked for; `subject` decides what it is looked for about.',
    );
  }

  const goal = OBJECTIVES[request.objective];
  if (!goal) {
    throw new SingularityError(
      'MESH_UNKNOWN_OBJECTIVE',
      `"${request.objective}" is not an objective this mesh knows.`,
      `Pick one of: ${Object.keys(OBJECTIVES).join(', ')}.`,
    );
  }

  const maxCalls = clamp(request.maxCalls, DEFAULT_MAX_CALLS, CALL_CEILING);
  const beam = clamp(request.beam, DEFAULT_BEAM, BEAM_CEILING);

  const board = new Blackboard();
  const notes = seed(board, request);

  const ctx: MeshContext = {
    subject,
    objective: request.objective,
    ...(request.chain ? { chainHint: getChain(request.chain).id } : {}),
    ...(request.budget !== undefined ? { budget: request.budget } : {}),
  };

  if (request.plan) return planOnly(request, ctx, board, goal, maxCalls, beam, notes);

  const executed = new Set<string>();
  const steps: MeshStep[] = [];
  let spent = 0;
  let calls = 0;
  let wave = 0;
  let backtracks = 0;
  let barren = 0;
  let stopped = 'the objective was satisfied';

  while (calls < maxCalls) {
    if (board.missing(goal).length === 0) break;

    const candidates = expand(board, ctx, goal, executed, spent, false);
    if (candidates.length === 0) {
      stopped = 'no applicable move remained';
      break;
    }

    wave += 1;
    const wanted = Math.min(beam, maxCalls - calls);
    const chosen = candidates.slice(0, wanted);
    for (const candidate of chosen) executed.add(candidate.move.tool);
    calls += chosen.length;

    const settled = await Promise.all(
      chosen.map(async (candidate) => {
        const args = candidate.move.args(board, ctx);
        try {
          return { candidate, args, result: await runner(candidate.move.tool, args) };
        } catch (err) {
          return { candidate, args, error: errorOf(err) };
        }
      }),
    );

    let elected = 0;
    for (const outcome of settled) {
      const { candidate, args } = outcome;
      const errored = 'error' in outcome;
      const proved = errored ? [] : candidate.move.bind(board, outcome.result, ctx);
      const carried = errored ? null : weakest(findCompleteness(outcome.result));

      const reward = scoreStep({
        errored,
        boundGoal: proved.filter((slot) => goal.includes(slot)),
        bound: proved,
        completeness: carried,
      });

      spent += candidate.move.cost + (errored ? FAILURE_PENALTY : 0);
      if (reward.extend) elected += 1;

      steps.push({
        wave,
        tool: candidate.move.tool,
        args,
        rank: candidate.rank,
        proved,
        reward,
        kept: reward.extend,
        ...(carried ? { completeness: carried } : {}),
        ...(!errored && carriesUntrusted(outcome.result) ? { untrusted: true as const } : {}),
        ...(errored ? { error: outcome.error } : {}),
      });
    }

    if (elected === 0) {
      backtracks += 1;
      barren += 1;
      // Two barren waves in a row means the frontier is rebuilding out of
      // moves that cannot pay, and spending the rest of the budget proving
      // that again helps nobody.
      if (barren >= 2) {
        stopped = 'two waves in a row proved nothing, so the search backtracked out of moves to try';
        break;
      }
    } else {
      barren = 0;
    }
  }

  if (calls >= maxCalls && board.missing(goal).length > 0) {
    stopped = `the call budget of ${maxCalls} was spent`;
  }

  const budgetSpent = calls >= maxCalls;
  const unproven: Unproven[] = board
    .missing(goal)
    .map((fact) => ({ fact, why: explainUnproven(fact, board, ctx, steps, budgetSpent) }));

  const proved = goal.length - unproven.length;
  const path = steps.filter((step) => step.kept);
  const discarded = steps.filter((step) => !step.kept);

  if (steps.some((step) => step.untrusted)) notes.push(UNTRUSTED_NOTE);
  notes.push(
    'Facts are summaries, not the tools’ full answers. Every step records the tool and the exact arguments it was called with, so any one of them can be re-run for the whole payload.',
  );
  notes.push(
    'Rewards are arithmetic over what each call returned about itself — its completeness, whether it errored, what it proved. Nothing here judged how good a step looked.',
  );

  return {
    objective: request.objective,
    subject,
    ...(board.value<string>('chain') ? { chain: board.value<string>('chain') } : {}),
    verdict: unproven.length === 0 ? 'answered' : proved > 0 ? 'partial' : 'unanswerable',
    waves: wave,
    calls,
    stopped,
    backtracks,
    path,
    discarded,
    facts: Object.fromEntries(
      Object.entries(board.snapshot()).map(([kind, fact]) => [kind, { value: fact.value, source: fact.source }]),
    ),
    sigma: sigma(
      steps.map((step) => step.reward.value),
      proved,
      goal.length,
    ),
    unproven,
    completeness: composeCompleteness(steps, goal, unproven),
    notes,
  };
}

/**
 * The same search, against an oracle that assumes every move answers in full.
 *
 * Useful for exactly one thing: seeing what a run would cost and in what order
 * it would proceed, without spending a call. It is a plan and not a
 * prediction — the real run re-ranks after every wave, and the first move that
 * returns something unexpected will change everything after it.
 */
function planOnly(
  request: MeshRequest,
  ctx: MeshContext,
  board: Blackboard,
  goal: FactKind[],
  maxCalls: number,
  beam: number,
  notes: string[],
): MeshResult {
  const executed = new Set<string>();
  const plan: PlannedStep[] = [];
  let spent = 0;
  let calls = 0;
  let wave = 0;
  let stopped = 'the objective would be satisfied';

  while (calls < maxCalls && board.missing(goal).length > 0) {
    const candidates = expand(board, ctx, goal, executed, spent, true);
    if (candidates.length === 0) {
      stopped = 'no applicable move would remain';
      break;
    }

    wave += 1;
    for (const candidate of candidates.slice(0, Math.min(beam, maxCalls - calls))) {
      executed.add(candidate.move.tool);
      spent += candidate.move.cost;
      calls += 1;
      plan.push({
        wave,
        tool: candidate.move.tool,
        rank: candidate.rank,
        wouldProve: candidate.wouldProve,
        ...(candidate.conditional ? { conditional: candidate.conditional } : {}),
      });

      // The oracle: every slot the move claims, filled. Marked as such, so a
      // plan can never be mistaken for a result.
      for (const slot of candidate.move.binds) {
        board.bind(slot, { assumedByPlan: true }, `plan:${candidate.move.tool}`);
      }
    }
  }

  if (calls >= maxCalls && board.missing(goal).length > 0) {
    stopped = `the call budget of ${maxCalls} would be spent first`;
  }

  const unproven: Unproven[] = board
    .missing(goal)
    .map((fact) => ({ fact, why: 'No move in this plan would prove it.' }));

  return {
    objective: request.objective,
    subject: ctx.subject,
    ...(request.chain ? { chain: ctx.chainHint } : {}),
    verdict: 'planned',
    waves: wave,
    calls: 0,
    stopped,
    backtracks: 0,
    path: [],
    discarded: [],
    plan,
    facts: {},
    sigma: { earned: 0, ceiling: plan.length * MAX_STEP_REWARD, ratio: 0, floor: 0, proved: 0, sought: goal.length },
    unproven,
    completeness: completeness.failed(
      'Nothing was called. This is the order the moves would be attempted in and what each would cost, not an answer about the subject.',
    ),
    notes: [
      ...notes,
      'A plan assumes every move answers completely, which is the one thing a real run cannot assume. Ordering after the first wave will differ.',
    ],
  };
}
