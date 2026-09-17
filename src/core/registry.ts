import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { BUILTIN_CHAINS, DEFAULT_PORTFOLIO_CHAINS } from './chains.js';
import { UnknownChainError, SingularityError } from './errors.js';
import type { AddressBookValue } from './address-book.js';
import type { ChainSpec, ChainFamily } from './types.js';

export interface UserConfig {
  /** Extra chains, or overrides for built-ins keyed by matching `id`. */
  chains?: Partial<ChainSpec>[];
  /** Addresses to use when a command is run with no address. */
  defaultAddresses?: Record<string, string>;
  /**
   * Named address book: `"vault": "0x…"`, or the pinned form
   * `"vault": { "target": "vault.eth", "pin": "0x…" }`. See `address-book.ts`
   * for what a pin promises.
   */
  addressBook?: Record<string, AddressBookValue>;
  /** Chains used by `portfolio` when none are named. */
  portfolioChains?: string[];
}

function configPath(): string {
  return process.env.SINGULARITY_CONFIG || join(homedir(), '.singularity', 'config.json');
}

let cachedConfig: UserConfig | null = null;

export function loadUserConfig(force = false): UserConfig {
  if (cachedConfig && !force) return cachedConfig;
  const path = configPath();
  if (!existsSync(path)) {
    cachedConfig = {};
    return cachedConfig;
  }
  try {
    cachedConfig = JSON.parse(readFileSync(path, 'utf8')) as UserConfig;
  } catch (err) {
    throw new SingularityError(
      'BAD_CONFIG',
      `Could not parse config at ${path}: ${(err as Error).message}`,
      'Fix the JSON, or delete the file to fall back to built-in defaults.',
    );
  }
  return cachedConfig;
}

/** `SINGULARITY_RPC_BASE_SEPOLIA` overrides the `base-sepolia` endpoint list. */
function envRpcOverride(id: string): string | undefined {
  const key = `SINGULARITY_RPC_${id.toUpperCase().replace(/-/g, '_')}`;
  const value = process.env[key];
  return value && value.trim() ? value.trim() : undefined;
}

let cachedChains: ChainSpec[] | null = null;

export function allChains(force = false): ChainSpec[] {
  if (cachedChains && !force) return cachedChains;
  const config = loadUserConfig(force);
  const byId = new Map<string, ChainSpec>();

  for (const chain of BUILTIN_CHAINS) {
    byId.set(chain.id, { ...chain, rpc: [...chain.rpc] });
  }

  // User entries either patch a built-in or define a brand new chain.
  for (const patch of config.chains ?? []) {
    if (!patch.id) {
      throw new SingularityError('BAD_CONFIG', 'Every entry in config.chains needs an "id".');
    }
    const existing = byId.get(patch.id);
    if (existing) {
      byId.set(patch.id, { ...existing, ...patch } as ChainSpec);
      continue;
    }
    if (!patch.family || !patch.nativeCurrency || !patch.rpc?.length) {
      throw new SingularityError(
        'BAD_CONFIG',
        `New chain "${patch.id}" is incomplete.`,
        'A new chain needs at least: id, family, nativeCurrency {name,symbol,decimals}, rpc[].',
      );
    }
    byId.set(patch.id, { name: patch.id, ...patch } as ChainSpec);
  }

  // Env overrides win over both built-ins and the config file.
  for (const chain of byId.values()) {
    const override = envRpcOverride(chain.id);
    if (override) chain.rpc = override.split(',').map((s) => s.trim()).filter(Boolean);
  }

  cachedChains = [...byId.values()];
  return cachedChains;
}

/** Resolve a chain by id, alias, numeric EVM chain id, or cosmos chain-id. */
export function getChain(ref: string | number): ChainSpec {
  const chains = allChains();
  const needle = String(ref).trim().toLowerCase();

  const byId = chains.find((c) => c.id.toLowerCase() === needle);
  if (byId) return byId;

  const byAlias = chains.find((c) => c.aliases?.some((a) => a.toLowerCase() === needle));
  if (byAlias) return byAlias;

  const byChainId = chains.find((c) => String(c.chainId ?? '').toLowerCase() === needle);
  if (byChainId) return byChainId;

  const byName = chains.find((c) => c.name.toLowerCase() === needle);
  if (byName) return byName;

  throw new UnknownChainError(String(ref), chains.map((c) => c.id));
}

export function chainsByFamily(family: ChainFamily): ChainSpec[] {
  return allChains().filter((c) => c.family === family);
}

export function portfolioChains(): string[] {
  const configured = loadUserConfig().portfolioChains;
  return configured?.length ? configured : DEFAULT_PORTFOLIO_CHAINS;
}

/** Test seam: drop memoized config/chains so env changes take effect. */
export function resetRegistry(): void {
  cachedConfig = null;
  cachedChains = null;
}
