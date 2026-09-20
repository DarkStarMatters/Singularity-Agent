import { describe, it, expect } from 'vitest';
import { flags } from '../src/telegram/commands.js';

/**
 * `--flag value` off a whitespace-split command line.
 *
 * Small enough to look obviously right and worth testing anyway, because the
 * failure it guards against is silent: a flag given no value swallows the next
 * flag as its argument, and `/pay 1 --to --sender <addr>` becomes a payment to
 * an address called "--sender". Nothing throws; a QR is produced; it pays
 * nobody.
 */

describe('reading flags out of a command line', () => {
  it('separates positional arguments from named ones', () => {
    const { positional, flag } = flags(['0.01', '--to', 'ADDR', '--order', '42']);

    expect(positional).toEqual(['0.01']);
    expect(flag('to')).toBe('ADDR');
    expect(flag('order')).toBe('42');
  });

  it('returns undefined for a flag nobody passed', () => {
    expect(flags(['0.01']).flag('to')).toBeUndefined();
  });

  it('ignores case in the flag name', () => {
    expect(flags(['1', '--TO', 'ADDR']).flag('to')).toBe('ADDR');
    expect(flags(['1', '--to', 'ADDR']).flag('TO')).toBe('ADDR');
  });

  it('does not let a valueless flag swallow the next one', () => {
    // The bug this exists for. Without the guard, `to` would be "--sender" and
    // the payment would name an address that is not one.
    const { flag } = flags(['0.01', '--to', '--sender', 'WALLET']);

    expect(flag('to')).toBeUndefined();
    expect(flag('sender')).toBe('WALLET');
  });

  it('ignores a trailing flag with nothing after it', () => {
    const { positional, flag } = flags(['0.01', '--to']);

    expect(flag('to')).toBeUndefined();
    expect(positional).toEqual(['0.01']);
  });

  it('keeps positional order when flags are interleaved', () => {
    const { positional } = flags(['25', '--to', 'ADDR', 'MINT', '--order', '7', 'EXTRA']);
    expect(positional).toEqual(['25', 'MINT', 'EXTRA']);
  });

  it('takes the last value when a flag is repeated', () => {
    // Not an error: a repeated flag is a corrected typo far more often than it
    // is an attempt at two recipients, and two recipients is not a thing here.
    expect(flags(['1', '--to', 'FIRST', '--to', 'SECOND']).flag('to')).toBe('SECOND');
  });

  it('handles an empty command line', () => {
    const { positional, flag } = flags([]);
    expect(positional).toEqual([]);
    expect(flag('to')).toBeUndefined();
  });

  it('treats a bare double dash as a flag with no name', () => {
    // Degenerate, but it must not crash or capture the next argument as a
    // recipient.
    const { flag } = flags(['1', '--', 'ADDR']);
    expect(flag('to')).toBeUndefined();
    expect(flag('')).toBe('ADDR');
  });
});
