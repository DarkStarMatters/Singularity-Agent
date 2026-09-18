import type { Amount, ChainSpec } from './types.js';

/**
 * Format base units as a human decimal string without floating point.
 *
 * Trailing zeros are trimmed, but we never render a non-zero balance as "0" —
 * dust still shows, because "0" next to a real balance is a lie an agent will
 * happily repeat.
 */
export function formatUnits(raw: bigint | string, decimals: number, maxFractionDigits = 8): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;

  if (decimals === 0) return `${negative ? '-' : ''}${abs.toString()}`;

  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;

  let fractionStr = fraction.toString().padStart(decimals, '0');

  if (fractionStr.length > maxFractionDigits) {
    const kept = fractionStr.slice(0, maxFractionDigits);
    // Only truncate when doing so does not erase the entire value.
    fractionStr = /[1-9]/.test(kept) || whole > 0n ? kept : fractionStr;
  }

  fractionStr = fractionStr.replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fractionStr ? `${sign}${whole}.${fractionStr}` : `${sign}${whole}`;
}

/** Parse a human decimal string into base units. Rejects silent precision loss. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d+)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error(`"${value}" is not a decimal number.`);
  }
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  if (fraction.length > decimals) {
    throw new Error(
      `"${value}" has ${fraction.length} decimal places but this asset only has ${decimals}.`,
    );
  }
  const padded = fraction.padEnd(decimals, '0');
  const result = BigInt(`${whole || '0'}${padded || ''}`);
  return negative ? -result : result;
}

export function amount(raw: bigint | string, decimals: number, symbol: string): Amount {
  const rawStr = typeof raw === 'bigint' ? raw.toString() : raw;
  return { raw: rawStr, formatted: formatUnits(rawStr, decimals), decimals, symbol };
}

/**
 * An amount in base units, for a denom whose decimals nothing declares.
 *
 * `formatted` is the raw integer rather than a decimal string, so nothing
 * downstream can read a scale into it that the chain never stated.
 */
export function baseUnits(raw: bigint | string, symbol: string): Amount {
  const rawStr = typeof raw === 'bigint' ? raw.toString() : raw;
  return { raw: rawStr, formatted: rawStr, decimals: 0, symbol, decimalsUnknown: true };
}

export function nativeAmount(raw: bigint | string, chain: ChainSpec): Amount {
  return amount(raw, chain.nativeCurrency.decimals, chain.nativeCurrency.symbol);
}

/** "0x1234…abcd" — for summaries, never for machine-readable fields. */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function toIso(seconds: number | bigint | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

export function explorerUrl(
  chain: ChainSpec,
  kind: 'tx' | 'address' | 'block',
  value: string,
): string | undefined {
  if (!chain.explorer) return undefined;
  const base = chain.explorer.replace(/\/$/, '');
  switch (chain.family) {
    case 'evm':
      return `${base}/${kind}/${value}`;
    case 'svm': {
      const segment = kind === 'tx' ? 'tx' : kind === 'address' ? 'account' : 'block';
      return `${base}/${segment}/${value}`;
    }
    case 'utxo': {
      const segment = kind === 'tx' ? 'tx' : kind === 'address' ? 'address' : 'block';
      return `${base}/${segment}/${value}`;
    }
    case 'cosmos': {
      const segment = kind === 'tx' ? 'tx' : kind === 'address' ? 'account' : 'block';
      return `${base}/${segment}/${value}`;
    }
    default:
      return undefined;
  }
}

/** JSON.stringify replacer that survives bigints — RPCs return them everywhere. */
export function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function toJson(value: unknown, indent = 2): string {
  return JSON.stringify(value, bigintSafe, indent);
}
