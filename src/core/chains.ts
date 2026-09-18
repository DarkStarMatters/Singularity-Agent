import type { ChainSpec } from './types.js';

const eth = { name: 'Ether', symbol: 'ETH', decimals: 18 };
const sepoliaEth = { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 };

/**
 * Curated registry. Public endpoints are deliberately keyless so the tool works
 * on first run; anything serious should override them via SINGULARITY_RPC_<ID>
 * or ~/.singularity/config.json.
 */
export const BUILTIN_CHAINS: ChainSpec[] = [
  // ---------------------------------------------------------------- EVM
  {
    id: 'ethereum',
    name: 'Ethereum',
    family: 'evm',
    chainId: 1,
    nativeCurrency: eth,
    rpc: ['https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com', 'https://rpc.ankr.com/eth'],
    explorer: 'https://etherscan.io',
    aliases: ['eth', 'mainnet', 'l1'],
  },
  {
    id: 'base',
    name: 'Base',
    family: 'evm',
    chainId: 8453,
    nativeCurrency: eth,
    rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org',
  },
  {
    id: 'arbitrum',
    name: 'Arbitrum One',
    family: 'evm',
    chainId: 42161,
    nativeCurrency: eth,
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorer: 'https://arbiscan.io',
    aliases: ['arb', 'arbitrum-one'],
  },
  {
    id: 'optimism',
    name: 'OP Mainnet',
    family: 'evm',
    chainId: 10,
    nativeCurrency: eth,
    rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    explorer: 'https://optimistic.etherscan.io',
    aliases: ['op', 'oeth'],
  },
  {
    id: 'polygon',
    name: 'Polygon PoS',
    family: 'evm',
    chainId: 137,
    nativeCurrency: { name: 'Polygon Ecosystem Token', symbol: 'POL', decimals: 18 },
    rpc: ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'],
    explorer: 'https://polygonscan.com',
    aliases: ['matic'],
  },
  {
    id: 'bsc',
    name: 'BNB Smart Chain',
    family: 'evm',
    chainId: 56,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
    explorer: 'https://bscscan.com',
    aliases: ['bnb', 'binance'],
  },
  {
    id: 'avalanche',
    name: 'Avalanche C-Chain',
    family: 'evm',
    chainId: 43114,
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
    explorer: 'https://snowtrace.io',
    aliases: ['avax'],
  },
  {
    id: 'gnosis',
    name: 'Gnosis Chain',
    family: 'evm',
    chainId: 100,
    nativeCurrency: { name: 'xDAI', symbol: 'XDAI', decimals: 18 },
    rpc: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'],
    explorer: 'https://gnosisscan.io',
    aliases: ['xdai'],
  },
  {
    id: 'scroll',
    name: 'Scroll',
    family: 'evm',
    chainId: 534352,
    nativeCurrency: eth,
    rpc: [
      'https://rpc.scroll.io',
      'https://scroll-rpc.publicnode.com',
      'https://scroll.drpc.org',
    ],
    explorer: 'https://scrollscan.com',
  },
  {
    id: 'linea',
    name: 'Linea',
    family: 'evm',
    chainId: 59144,
    nativeCurrency: eth,
    rpc: [
      'https://rpc.linea.build',
      'https://linea-rpc.publicnode.com',
      'https://linea.drpc.org',
    ],
    explorer: 'https://lineascan.build',
  },
  {
    id: 'zksync',
    name: 'ZKsync Era',
    family: 'evm',
    chainId: 324,
    nativeCurrency: eth,
    rpc: ['https://mainnet.era.zksync.io', 'https://zksync.drpc.org'],
    explorer: 'https://explorer.zksync.io',
    aliases: ['era', 'zksync-era'],
  },
  {
    id: 'sepolia',
    name: 'Sepolia',
    family: 'evm',
    chainId: 11155111,
    nativeCurrency: sepoliaEth,
    rpc: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
    explorer: 'https://sepolia.etherscan.io',
    testnet: true,
  },
  {
    id: 'base-sepolia',
    name: 'Base Sepolia',
    family: 'evm',
    chainId: 84532,
    nativeCurrency: sepoliaEth,
    rpc: ['https://sepolia.base.org'],
    explorer: 'https://sepolia.basescan.org',
    testnet: true,
  },

  {
    id: 'blast',
    name: 'Blast',
    family: 'evm',
    chainId: 81457,
    nativeCurrency: eth,
    rpc: ['https://rpc.blast.io', 'https://blast-rpc.publicnode.com', 'https://blast.drpc.org'],
    explorer: 'https://blastscan.io',
  },
  {
    id: 'mantle',
    name: 'Mantle',
    family: 'evm',
    chainId: 5000,
    nativeCurrency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
    rpc: ['https://rpc.mantle.xyz', 'https://mantle-rpc.publicnode.com', 'https://mantle.drpc.org'],
    explorer: 'https://mantlescan.xyz',
    aliases: ['mnt'],
  },
  {
    id: 'mode',
    name: 'Mode',
    family: 'evm',
    chainId: 34443,
    nativeCurrency: eth,
    rpc: ['https://mainnet.mode.network', 'https://mode.drpc.org', 'https://1rpc.io/mode'],
    explorer: 'https://explorer.mode.network',
  },
  {
    id: 'fraxtal',
    name: 'Fraxtal',
    family: 'evm',
    chainId: 252,
    // Not frxETH. Fraxtal's gas token is FRAX, and taking the obvious guess
    // would mean every fee on this chain was reported in the wrong asset.
    nativeCurrency: { name: 'Frax', symbol: 'FRAX', decimals: 18 },
    rpc: ['https://rpc.frax.com', 'https://fraxtal-rpc.publicnode.com', 'https://fraxtal.drpc.org'],
    explorer: 'https://fraxscan.com',
    aliases: ['frax'],
  },
  {
    id: 'opbnb',
    name: 'opBNB',
    family: 'evm',
    chainId: 204,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpc: [
      'https://opbnb-mainnet-rpc.bnbchain.org',
      'https://opbnb-rpc.publicnode.com',
      'https://opbnb.drpc.org',
    ],
    explorer: 'https://mainnet.opbnbscan.com',
    aliases: ['op-bnb'],
  },

  // ---------------------------------------------------------------- SVM
  {
    id: 'solana',
    name: 'Solana',
    family: 'svm',
    nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
    rpc: [
      'https://api.mainnet-beta.solana.com',
      'https://solana-rpc.publicnode.com',
      // Replaces solana.drpc.org, which answered every request with "chain is
      // not available on free plan". An endpoint that cannot serve anything is
      // not failover — it is a third line of noise on every error message, and
      // it made a two-endpoint chain look like a three-endpoint one.
      'https://solana.leorpc.com/?api_key=FREE',
    ],
    explorer: 'https://solscan.io',
    aliases: ['sol'],
  },
  {
    id: 'solana-devnet',
    name: 'Solana Devnet',
    family: 'svm',
    nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
    rpc: ['https://api.devnet.solana.com'],
    explorer: 'https://solscan.io',
    testnet: true,
  },

  // --------------------------------------------------------------- UTXO
  {
    id: 'bitcoin',
    name: 'Bitcoin',
    family: 'utxo',
    nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 8 },
    rpc: ['https://mempool.space/api', 'https://blockstream.info/api'],
    explorer: 'https://mempool.space',
    aliases: ['btc'],
  },
  {
    id: 'bitcoin-testnet',
    name: 'Bitcoin Testnet',
    family: 'utxo',
    nativeCurrency: { name: 'Test Bitcoin', symbol: 'tBTC', decimals: 8 },
    rpc: ['https://mempool.space/testnet/api', 'https://blockstream.info/testnet/api'],
    explorer: 'https://mempool.space/testnet',
    testnet: true,
  },
  {
    id: 'litecoin',
    name: 'Litecoin',
    family: 'utxo',
    nativeCurrency: { name: 'Litecoin', symbol: 'LTC', decimals: 8 },
    rpc: ['https://litecoinspace.org/api'],
    explorer: 'https://litecoinspace.org',
    aliases: ['ltc'],
  },

  // ------------------------------------------------------------- Cosmos
  {
    id: 'cosmoshub',
    name: 'Cosmos Hub',
    family: 'cosmos',
    chainId: 'cosmoshub-4',
    nativeCurrency: { name: 'Atom', symbol: 'ATOM', decimals: 6 },
    rpc: ['https://rest.cosmos.directory/cosmoshub', 'https://cosmos-rest.publicnode.com'],
    explorer: 'https://www.mintscan.io/cosmos',
    bech32Prefix: 'cosmos',
    denom: 'uatom',
    aliases: ['cosmos', 'atom', 'gaia'],
  },
  {
    id: 'osmosis',
    name: 'Osmosis',
    family: 'cosmos',
    chainId: 'osmosis-1',
    nativeCurrency: { name: 'Osmosis', symbol: 'OSMO', decimals: 6 },
    rpc: ['https://rest.cosmos.directory/osmosis', 'https://osmosis-rest.publicnode.com'],
    explorer: 'https://www.mintscan.io/osmosis',
    bech32Prefix: 'osmo',
    denom: 'uosmo',
    aliases: ['osmo'],
  },
  {
    id: 'celestia',
    name: 'Celestia',
    family: 'cosmos',
    chainId: 'celestia',
    nativeCurrency: { name: 'Celestia', symbol: 'TIA', decimals: 6 },
    rpc: ['https://rest.cosmos.directory/celestia', 'https://celestia-rest.publicnode.com'],
    explorer: 'https://www.mintscan.io/celestia',
    bech32Prefix: 'celestia',
    denom: 'utia',
    aliases: ['tia'],
  },
  {
    id: 'injective',
    name: 'Injective',
    family: 'cosmos',
    chainId: 'injective-1',
    nativeCurrency: { name: 'Injective', symbol: 'INJ', decimals: 18 },
    rpc: ['https://rest.cosmos.directory/injective', 'https://injective-rest.publicnode.com'],
    explorer: 'https://www.mintscan.io/injective',
    bech32Prefix: 'inj',
    denom: 'inj',
    aliases: ['inj'],
  },
  {
    id: 'dydx',
    name: 'dYdX Chain',
    family: 'cosmos',
    chainId: 'dydx-mainnet-1',
    nativeCurrency: { name: 'dYdX', symbol: 'DYDX', decimals: 18 },
    rpc: ['https://rest.cosmos.directory/dydx', 'https://dydx-rest.publicnode.com'],
    explorer: 'https://www.mintscan.io/dydx',
    bech32Prefix: 'dydx',
    denom: 'adydx',
  },
  // Each of the four below was read off the chain before it was written here:
  // the chain id it reports, a head block seconds old, a bond denom from its
  // own staking params, and a bech32 prefix taken from a real validator
  // operator address rather than from the chain's name. Decimals were then
  // confirmed against the Cosmos chain registry's denom units, because `u` for
  // micro is a convention and not a promise — Injective above spends `inj` at
  // 18 and dYdX spends `adydx` at 18, and either one assumed at 6 would be
  // wrong by a factor of a trillion.
  {
    id: 'sei',
    name: 'Sei',
    family: 'cosmos',
    chainId: 'pacific-1',
    nativeCurrency: { name: 'Sei', symbol: 'SEI', decimals: 6 },
    rpc: [
      'https://rest.cosmos.directory/sei',
      'https://rest.sei-apis.com',
      'https://sei-api.polkachu.com',
    ],
    explorer: 'https://www.mintscan.io/sei',
    bech32Prefix: 'sei',
    denom: 'usei',
    aliases: ['pacific'],
  },
  {
    id: 'neutron',
    name: 'Neutron',
    family: 'cosmos',
    chainId: 'neutron-1',
    nativeCurrency: { name: 'Neutron', symbol: 'NTRN', decimals: 6 },
    rpc: ['https://rest.cosmos.directory/neutron', 'https://neutron-api.polkachu.com'],
    explorer: 'https://www.mintscan.io/neutron',
    bech32Prefix: 'neutron',
    denom: 'untrn',
    aliases: ['ntrn'],
  },
  {
    id: 'stride',
    name: 'Stride',
    family: 'cosmos',
    chainId: 'stride-1',
    nativeCurrency: { name: 'Stride', symbol: 'STRD', decimals: 6 },
    rpc: ['https://rest.cosmos.directory/stride', 'https://stride-api.polkachu.com'],
    explorer: 'https://www.mintscan.io/stride',
    bech32Prefix: 'stride',
    denom: 'ustrd',
    aliases: ['strd'],
  },
  {
    id: 'kava',
    name: 'Kava',
    family: 'cosmos',
    chainId: 'kava_2222-10',
    nativeCurrency: { name: 'Kava', symbol: 'KAVA', decimals: 6 },
    rpc: [
      'https://rest.cosmos.directory/kava',
      'https://kava-api.polkachu.com',
      'https://kava-rest.publicnode.com',
    ],
    explorer: 'https://www.mintscan.io/kava',
    bech32Prefix: 'kava',
    // Kava runs a Cosmos chain and an EVM chain under one name, and this entry
    // is the Cosmos one. Its chain id carries the EVM id inside a Cosmos
    // string — `kava_2222-10`, where 2222 is the EVM chain id. Resolution
    // matches chain ids exactly, so `2222` does not land here and an EVM Kava
    // could be added later without collision; test/registry.test.ts holds that,
    // because it is a property of the lookup rather than of this entry.
    denom: 'ukava',
  },
];

/** Chains queried by default when a portfolio request names no chains. */
export const DEFAULT_PORTFOLIO_CHAINS = [
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'solana',
  'bitcoin',
  'cosmoshub',
];
