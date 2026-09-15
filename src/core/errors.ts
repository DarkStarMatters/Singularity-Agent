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
