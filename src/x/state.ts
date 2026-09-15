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
