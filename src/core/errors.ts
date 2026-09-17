/**
 * Errors carry a `hint` because the consumer is usually a model that has to
 * decide what to do next. "Bad address" is not actionable; "expected 0x + 40
 * hex chars, got 39" is.
 */
export class SingularityError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'SingularityError';
    this.code = code;
    this.hint = hint;
  }
}

export class UnknownChainError extends SingularityError {
  constructor(chain: string, known: string[]) {
    const suggestions = closest(chain, known);
    super(
      'UNKNOWN_CHAIN',
      `Unknown chain "${chain}".`,
      suggestions.length
        ? `Did you mean: ${suggestions.join(', ')}? Run the "chains" tool for the full list.`
        : 'Run the "chains" tool to list supported chains, or add a custom one in ~/.singularity/config.json.',
    );
  }
}

export class InvalidAddressError extends SingularityError {
  constructor(address: string, family: string, expectation: string) {
    super(
      'INVALID_ADDRESS',
      `"${truncate(address)}" is not a valid ${family} address.`,
      expectation,
    );
  }
}

export class RpcError extends SingularityError {
  constructor(chain: string, detail: string, hint?: string) {
    super(
      'RPC_ERROR',
      `RPC call failed on ${chain}: ${detail}`,
      hint ??
        'Public endpoints are rate-limited. Set SINGULARITY_RPC_' +
          chain.toUpperCase().replace(/-/g, '_') +
          ' to your own endpoint.',
    );
  }
}

/**
 * The chain family has no way to address past state at all.
 *
 * Distinct from {@link HistoricalStateUnavailableError}: this one no endpoint
 * can fix, so the caller should stop asking rather than swap RPCs.
 */
export class HistoricalStateUnsupportedError extends SingularityError {
  constructor(chain: string, detail: string) {
    super(
      'HISTORICAL_STATE_UNSUPPORTED',
      `${chain} cannot read state at a past block.`,
      `${detail} Drop \`atBlock\` to read current state — this call returns nothing rather than passing current state off as historical.`,
    );
  }
}

/**
 * The chain can address past state, but this endpoint does not retain it.
 *
 * Always an error, never a fallback to current state: a pruned answer silently
 * downgraded to "now" is the one failure that corrupts every conclusion drawn
 * from it, and does so invisibly.
 */
export class HistoricalStateUnavailableError extends SingularityError {
  constructor(chain: string, atBlock: number, detail: string) {
    super(
      'HISTORICAL_STATE_UNAVAILABLE',
      `State at block ${atBlock} is not available from the configured ${chain} endpoints.`,
      `${detail} Point SINGULARITY_RPC_${chain.toUpperCase().replace(/-/g, '_')} at an archive node.`,
    );
  }
}

/**
 * A pinned address-book alias resolved to an address other than its pin.
 *
 * Deliberately an error and not a warning attached to a successful answer. The
 * whole failure being guarded against is the one nobody notices, and a result
 * that carries the new address plus a note about the old one still carries the
 * new address — every downstream consumer reads the field, and a model
 * composing a reply reads the field too.
 */
export class AliasPinMismatchError extends SingularityError {
  constructor(alias: string, pin: string, actual: string) {
    super(
      'ALIAS_PIN_MISMATCH',
      `Address-book alias "${alias}" is pinned to ${pin}, but resolves to ${actual} today.`,
      `Nothing here can tell those two apart on merit — the new answer is a valid resolution. If you moved the alias, update its "pin" to ${actual}. If you did not, the name changed hands or the config file was edited, and ${actual} is not who you meant. Pass an address directly to bypass the book.`,
    );
  }
}

/**
 * A pinned alias could not be checked, because its target resolved to nothing.
 *
 * Distinct from {@link AliasPinMismatchError}: no other address appeared, so
 * nothing was hijacked *yet*. It still stops, because an expired registration
 * resolves to nothing right up until somebody else registers it, and falling
 * back to the pinned address would turn the pin from a check into a source —
 * quietly keeping the alias working while the signal that it lapsed goes by.
 */
export class AliasPinUnverifiedError extends SingularityError {
  constructor(alias: string, target: string, pin: string) {
    super(
      'ALIAS_PIN_UNVERIFIED',
      `Address-book alias "${alias}" is pinned to ${pin}, and the pin could not be checked: "${target}" did not resolve to an address.`,
      `The registration may have expired, which is the state that precedes somebody else taking it. This call stops rather than using ${pin} on its own authority — pass ${pin} directly if that is what you meant, or repoint the alias.`,
    );
  }
}

export class UnsupportedOperationError extends SingularityError {
  constructor(operation: string, family: string, hint?: string) {
    super(
      'UNSUPPORTED',
      `"${operation}" is not supported on ${family} chains.`,
      hint,
    );
  }
}

function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Tiny edit-distance ranking, enough for "did you mean" on a ~30 item list. */
function closest(input: string, candidates: string[], limit = 3): string[] {
  const needle = input.toLowerCase();
  return candidates
    .map((c) => ({ c, d: distance(needle, c.toLowerCase()) }))
    .filter(({ c, d }) => d <= 3 || c.includes(needle))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(({ c }) => c);
}

function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const curr = [i, ...Array(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[cols - 1]!;
}
