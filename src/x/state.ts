/**
 * Where the X listener remembers what it has already answered.
 *
 * This is the one piece of state that genuinely must survive a restart. Without
 * it, every restart re-reads the recent mentions timeline and replies to posts
 * it has already replied to — in public, on the user's account. An in-memory
 * cursor would make a crash loop into a spam incident.
 *
 * It is a single small JSON file rather than a database, and a corrupt or
 * unreadable file is treated as "no cursor", which is the safe direction: the
 * listener then establishes a fresh starting point and answers nothing older.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface XState {
  /** Newest mention id already handled. Passed to the API as `since_id`. */
  sinceId?: string;
  /** The account the cursor belongs to; a different one invalidates it. */
  userId?: string;
  /** When the last unprompted project update went out, as epoch ms. */
  lastUpdateAt?: number;
  /** Angles used recently, newest first, so posts do not repeat themselves. */
  recentAngles?: string[];
  /**
   * The specific subjects posted about recently, newest first.
   *
   * Angles alone were never enough: six angles over a fact sheet that does not
   * change is six posts, after which the rotation just sets how often they
   * repeat. A subject is one chain, one tool, one limit, one recipe — so this
   * list is what actually stops the account saying the same thing twice, and
   * it is kept long because the candidate space is large.
   */
  recentSubjects?: string[];
  /**
   * The text of recent updates, newest first.
   *
   * Fed back into the prompt as "you already said this". Rotating angles alone
   * stops being enough once posts are frequent: at one an hour the five angles
   * come round in five hours, and without the actual wording to avoid, the
   * second pass reads like the first.
   */
  recentPosts?: string[];
  updatedAt?: string;
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SINGULARITY_X_STATE || join(homedir(), '.singularity', 'x-state.json');
}

export function loadState(path = statePath()): XState {
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as XState;
    // A hand-edited file could hold anything; only trust the right shapes.
    return {
      ...(typeof parsed.sinceId === 'string' ? { sinceId: parsed.sinceId } : {}),
      ...(typeof parsed.userId === 'string' ? { userId: parsed.userId } : {}),
      ...(typeof parsed.lastUpdateAt === 'number' ? { lastUpdateAt: parsed.lastUpdateAt } : {}),
      ...(Array.isArray(parsed.recentAngles)
        ? { recentAngles: parsed.recentAngles.filter((a): a is string => typeof a === 'string') }
        : {}),
      ...(Array.isArray(parsed.recentSubjects)
        ? {
            recentSubjects: parsed.recentSubjects.filter((s): s is string => typeof s === 'string'),
          }
        : {}),
      ...(Array.isArray(parsed.recentPosts)
        ? { recentPosts: parsed.recentPosts.filter((p): p is string => typeof p === 'string') }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Written via a temp file and renamed, so a crash mid-write cannot leave a
 * truncated cursor behind — which would read as "no cursor" and re-answer the
 * backlog.
 */
export function saveState(state: XState, path = statePath()): void {
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  const temporary = `${path}.tmp`;

  writeFileSync(temporary, payload, 'utf8');
  renameSync(temporary, path);
}

/**
 * The cursor is only usable for the account that wrote it. Swapping credentials
 * without this check would apply one account's id to another's timeline, where
 * it is meaningless — ids are global and increasing, so a newer account's
 * cursor would silently hide every mention on an older one.
 */
export function cursorFor(state: XState, userId: string): string | undefined {
  return state.userId === userId ? state.sinceId : undefined;
}
