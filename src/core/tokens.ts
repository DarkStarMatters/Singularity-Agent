/**
 * A small, keyless well-known token map.
 *
 * Without an indexer API key there is no way to enumerate "every token this
 * address holds", so `balance` checks this curated set plus any tokens the
 * caller names explicitly. The tool is always explicit that this is a scan of
 * known tokens, never a complete holdings list.
 */
export interface KnownToken {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
}

export const WELL_KNOWN_TOKENS: Record<string, KnownToken[]> = {
  ethereum: [
    { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    { symbol: 'WBTC', name: 'Wrapped BTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    { symbol: 'LINK', name: 'ChainLink Token', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
  ],
  base: [
    { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  ],
  arbitrum: [
    { symbol: 'USDC', name: 'USD Coin', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    { symbol: 'ARB', name: 'Arbitrum', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
  ],
  optimism: [
    { symbol: 'USDC', name: 'USD Coin', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'OP', name: 'Optimism', address: '0x4200000000000000000000000000000000000042', decimals: 18 },
  ],
  polygon: [
    { symbol: 'USDC', name: 'USD Coin', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
  ],
  bsc: [
    { symbol: 'USDT', name: 'Tether USD', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    { symbol: 'USDC', name: 'USD Coin', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    { symbol: 'WBNB', name: 'Wrapped BNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
  ],
  avalanche: [
    { symbol: 'USDC', name: 'USD Coin', address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
    { symbol: 'WAVAX', name: 'Wrapped AVAX', address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', decimals: 18 },
  ],
  gnosis: [
    { symbol: 'USDC', name: 'USD Coin', address: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', decimals: 6 },
    { symbol: 'WXDAI', name: 'Wrapped XDAI', address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', decimals: 18 },
  ],
  blast: [
    // Blast's own stablecoin, bridged from DAI rather than USDC — the symbol
    // is its own and the name is the symbol.
    { symbol: 'USDB', name: 'USDB', address: '0x4300000000000000000000000000000000000003', decimals: 18 },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4300000000000000000000000000000000000004', decimals: 18 },
  ],
  mantle: [
    // Deliberately absent: the ERC-20 MNT at 0xdead…0000 mirrors the native
    // balance rather than holding one of its own — balanceOf and eth_getBalance
    // return the same number for every address checked. Curating it would list
    // that balance twice, once as the gas asset and once as a token, and a
    // wallet holding 10 MNT would read as holding 20. The double count is worse
    // than the alternative: queried by address it is an uncurated symbol that
    // collides with the gas asset, so it gets an impersonation note that is
    // technically true and unhelpful here.
    { symbol: 'USDC', name: 'USD Coin', address: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD', address: '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE', decimals: 6 },
    { symbol: 'mETH', name: 'mETH', address: '0xcDA86A272531e8640cD7F1a92c01839911B90bb0', decimals: 18 },
  ],
  mode: [
    { symbol: 'USDC', name: 'USD Coin', address: '0xd988097fb8612cc24eeC14542bC03424c656005f', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD', address: '0xf0F161fDA2712DB8b566946122a5af183995e2eD', decimals: 6 },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  ],
  fraxtal: [
    { symbol: 'WFRAX', name: 'Wrapped Frax', address: '0xFc00000000000000000000000000000000000002', decimals: 18 },
    { symbol: 'frxUSD', name: 'Frax USD', address: '0xFc00000000000000000000000000000000000001', decimals: 18 },
    { symbol: 'sfrxUSD', name: 'Staked Frax USD', address: '0xFC00000000000000000000000000000000000008', decimals: 18 },
    { symbol: 'frxETH', name: 'Frax Ether', address: '0xFC00000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'sfrxETH', name: 'Staked Frax Ether', address: '0xFC00000000000000000000000000000000000005', decimals: 18 },
  ],
  opbnb: [
    { symbol: 'WBNB', name: 'Wrapped BNB', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    // Eighteen decimals, because these mirror BNB Chain tokens rather than
    // Ethereum ones. Assuming six here would misreport every balance by a
    // factor of a trillion.
    { symbol: 'USDT', name: 'Tether USD', address: '0x9e5AAC1Ba1a2e6aEd6b32689DFcF62A509Ca96f3', decimals: 18 },
    { symbol: 'ETH', name: 'Ethereum Token', address: '0xE7798f023fC62146e8Aa1b36Da45fb70855a77Ea', decimals: 18 },
    { symbol: 'FDUSD', name: 'First Digital USD', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  ],
  solana: [
    // Curated so the impersonation check has something to compare against. A
    // project token is the shape most worth copying — a clone carrying this
    // exact ticker at another address is how people lose money on an agent's
    // own community — and the check only fires for symbols this map knows.
    // Being in here also means this tool names it from its own text rather
    // than from the chain, which is the treatment USDC already gets.
    {
      symbol: 'SNGLRTY',
      name: 'Singularity-Agent',
      address: '5pTy48gtfzaR8NPUVZTbybVUGpQvFT4JsNHzwQE8pump',
      decimals: 6,
    },
    { symbol: 'USDC', name: 'USD Coin', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
    { symbol: 'JUP', name: 'Jupiter', address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
    { symbol: 'BONK', name: 'Bonk', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  ],
};

export function knownTokens(chainId: string): KnownToken[] {
  return WELL_KNOWN_TOKENS[chainId] ?? [];
}

/** Resolve a symbol like "usdc" to its address on a chain, if we know it. */
export function tokenBySymbol(chainId: string, symbol: string): KnownToken | undefined {
  const needle = symbol.trim().toLowerCase();
  return knownTokens(chainId).find((t) => t.symbol.toLowerCase() === needle);
}
