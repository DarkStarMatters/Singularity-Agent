import type { ChainAdapter } from '../core/adapter.js';
import type { ChainFamily, ChainSpec } from '../core/types.js';
import { SingularityError } from '../core/errors.js';
import { evmAdapter } from './evm.js';
import { solanaAdapter } from './solana.js';
import { bitcoinAdapter } from './bitcoin.js';
import { cosmosAdapter } from './cosmos.js';

const ADAPTERS: Record<ChainFamily, ChainAdapter> = {
  evm: evmAdapter,
  svm: solanaAdapter,
  utxo: bitcoinAdapter,
  cosmos: cosmosAdapter,
};

export function adapterFor(chain: ChainSpec): ChainAdapter {
  const adapter = ADAPTERS[chain.family];
  if (!adapter) {
    throw new SingularityError('NO_ADAPTER', `No adapter is registered for family "${chain.family}".`);
  }
  return adapter;
}

export function adapterForFamily(family: ChainFamily): ChainAdapter {
  return ADAPTERS[family];
}

export { evmAdapter, solanaAdapter, bitcoinAdapter, cosmosAdapter };
