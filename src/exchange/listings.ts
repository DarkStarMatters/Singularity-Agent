/**
 * What Singularity sells on the PrivateDAO exchange, and for how much.
 *
 * The exchange runs the marketplace: discovery, the quote, the payment, routing
 * the paid request here, and the receipt. What it needs from a seller is
 * commercial metadata per service — title, description, price, asset, input and
 * output schemas, and where the money goes. This module is that metadata, and
 * the one place it lives.
 *
 * ## Derived, not restated
 *
 * The input schema of every listing is generated from the tool catalogue — the
 * same zod shape the MCP server registers — rather than written out again. A
 * listing whose schema drifted from the tool behind it would sell calls that
 * fail, and the exchange would be the one to find out. The output schemas are
 * written by hand, because nothing in the code declares them, and are held
 * instead to real outputs recorded from each tool (`test/fixtures/seller/`).
 *
 * ## What is sold
 *
 * Only read-only tools. The `build_*` tools return unsigned transactions and are
 * not for sale through a marketplace that routes requests on a stranger's
 * behalf; the check that refuses them is below, not in a comment.
 *
 * ## How the prices were set
 *
 * Three references, in this order:
 *
 * 1. **The market these listings sit in.** The exchange's own catalogue prices
 *    comparable reads at 0.01–0.10 USDC — `risk.score` 0.02, `transaction.simulate`
 *    0.02, `token.intelligence` 0.03, `launch.check` 0.03, `transaction.explain`
 *    0.05, `contract.inspect` 0.08, `research.asset` 0.10. A seller priced above
 *    the first-party equivalent is not bought; one priced far below it signals a
 *    worse answer. Each listing sits at or just under its nearest comparable.
 * 2. **What a call costs to serve.** Every tool here reads public RPC state and
 *    holds nothing, so the marginal cost is endpoint load, measured in the round
 *    trips the mesh already assigns each move. Price scales with that count
 *    rather than with how impressive the answer sounds.
 * 3. **The payment rail.** Settlement is USDC on Solana: a stable unit, so a
 *    buyer's price does not move with a volatile token between quote and payment,
 *    and a transfer costs the buyer a 5,000-lamport base fee. No price here is
 *    below 0.02 USDC, so that fee stays a small fraction of what is paid.
 *
 * `inspect_payment` is the deliberate exception to "price by value": it guards
 * payments worth far more than it costs, and it only works if it is run before
 * *every* one. It is priced to be habitual rather than to capture that value.
 *
 * Prices are gross. Whatever share the exchange takes is its to state.
 */

import { SingularityError } from '../core/errors.js';
import { TOOLS_BY_NAME } from '../tools/catalog.js';
import { shapeToJsonSchema, type JsonSchema } from '../tools/json-schema.js';

/** Solana mainnet USDC, the only asset these listings settle in. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Where a paid request is routed: the hosted server, the same tools as everywhere else. */
export const SELLER_ENDPOINT = 'https://mcp-singularity.cicada71.net/mcp';

/**
 * Who is selling, and where the proceeds go.
 *
 * The payout wallet already holds a USDC token account
 * (`AS6s3mBr6VGsa7tQJEaivjKuk8fALWKUmNQzYc7Ej4Mg`), so a settlement can be paid
 * into it without the payer having to create one first.
 */
export const SELLER = {
  name: 'SingularityAgent',
  agentId: 'agent_3884f6355724a1e850d31f45',
  endpoint: SELLER_ENDPOINT,
  protocol: 'MCP',
  payoutAddress: 'BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH',
  payoutNetwork: 'solana-mainnet-beta',
  payoutAsset: { symbol: 'USDC', mint: USDC_MINT, decimals: 6 },
  source: 'https://github.com/DarkStarMatters/Singularity-Agent',
} as const;

/** The exchange's own category names, so a listing files where a buyer looks. */
export type ExchangeCategory = 'Verification' | 'Intelligence' | 'Risk' | 'Transactions' | 'Agent Services';

interface ListingSpec {
  tool: string;
  title: string;
  category: ExchangeCategory;
  price: number;
  summary: string;
  customerValue: string;
  /** Why this price, against the exchange's own catalogue. */
  pricing: string;
  supportedNetworks: string[];
  output: JsonSchema;
}

const completeness: JsonSchema = {
  type: 'object',
  description: 'How much of the answer this is. Read before concluding anything is absent.',
  properties: {
    kind: { type: 'string', enum: ['exhaustive', 'curated', 'truncated', 'failed'] },
    note: { type: 'string' },
  },
  required: ['kind', 'note'],
};

const SPECS: ListingSpec[] = [
  {
    tool: 'mint_audit',
    title: 'Solana mint audit',
    category: 'Risk',
    price: 0.02,
    summary:
      "Who holds power over a Solana token: mint and freeze authority, Token-2022 extensions (permanent delegate, transfer hook, transfer fee), each named with its holder, and which of those powers are settled for good.",
    customerValue:
      'Before accepting or holding a token, know who can mint more, freeze your balance, or move it without your signature — by mint address, never by ticker.',
    pricing: 'One account read. Priced at risk.score (0.02), below token.intelligence (0.03), which adds holder data this does not.',
    supportedNetworks: ['solana-mainnet-beta'],
    output: {
      type: 'object',
      properties: {
        chain: { type: 'string' },
        mint: { type: 'string' },
        program: { type: 'string', description: 'spl-token or spl-token-2022.' },
        decimals: { type: 'number' },
        supply: { type: 'object' },
        powers: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, holder: { type: 'string' } } } },
        settled: { type: 'array', description: 'Powers revoked for good.' },
        extensions: { type: 'array' },
        completeness,
        note: { type: 'string' },
      },
      required: ['chain', 'mint', 'program', 'decimals', 'powers', 'extensions', 'completeness', 'note'],
    },
  },
  {
    tool: 'inspect_exit',
    title: 'Can this token be sold again',
    category: 'Risk',
    price: 0.03,
    summary:
      'Before buying a Solana token, the specific mechanisms that could stop you selling it — transfer hook, permanent delegate, live freeze authority, default-frozen accounts, non-transferability, transfer fees, concentrated supply — each with who holds the power.',
    customerValue:
      'Names what can trap a position before it is taken, instead of a score. States plainly that it does not judge liquidity or price.',
    pricing: 'Mint plus largest-holder reads (three round trips). Priced at token.intelligence and launch.check (0.03).',
    supportedNetworks: ['solana-mainnet-beta'],
    output: {
      type: 'object',
      properties: {
        mint: { type: 'string' },
        chain: { type: 'string' },
        canExit: { type: 'boolean', description: 'False when a mechanism can block a sale or seize the balance. True is not "safe to buy".' },
        underThirdPartyControl: { type: 'boolean' },
        risks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              mechanism: { type: 'string' },
              severity: { type: 'string', enum: ['blocks', 'discretionary', 'degrades'] },
              holder: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['mechanism', 'severity', 'note'],
          },
        },
        completeness,
        note: { type: 'string' },
      },
      required: ['mint', 'chain', 'canExit', 'risks', 'completeness', 'note'],
    },
  },
  {
    tool: 'inspect_payment',
    title: 'Check a payment demand before signing',
    category: 'Transactions',
    price: 0.02,
    summary:
      'Takes an invoice or payment intent as it arrived and checks every claim against the chain: the destination account exists, holds that mint and belongs to the payee; the displayed and base-unit amounts agree; decimals and ticker match the token; the expiry has not passed; the mint charges no hidden transfer fee. Solana and EVM.',
    customerValue:
      'Catches the payment that cannot do what the invoice says before it is signed — the wrong token under the right ticker, an account that does not exist, an amount off by the decimals.',
    pricing:
      'A few account reads. Priced at transaction.simulate (0.02) and deliberately low: it only protects a buyer who runs it before every payment.',
    supportedNetworks: ['solana-mainnet-beta', 'ethereum-mainnet', 'base-mainnet', 'arbitrum-mainnet'],
    output: {
      type: 'object',
      properties: {
        chain: { type: 'string' },
        verdict: { type: 'string', enum: ['payable', 'unpayable', 'unproven'], description: '`unproven` is not cleared.' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              severity: { type: 'string', enum: ['fatal', 'warning', 'note'] },
              detail: { type: 'string' },
            },
            required: ['code', 'severity', 'detail'],
          },
        },
        destination: { type: 'object' },
        token: { type: 'object' },
        note: { type: 'string' },
      },
      required: ['chain', 'verdict', 'findings', 'note'],
    },
  },
  {
    tool: 'prove_payment',
    title: 'Prove a payment met its demand',
    category: 'Verification',
    price: 0.03,
    summary:
      "After paying, prove from the chain alone that the payment met the demand it answered: payee, mint, exact token account, amount, memo, deadline and payer, each checked against the finalized transaction with expected and observed side by side. Solana.",
    customerValue:
      "Evidence a payer assembles without the payee's cooperation — the answer to \"it never arrived\", \"it arrived late\" or \"it went to the wrong account\", in a form anyone holding the signature can re-derive.",
    pricing: 'One finalized transaction read. Priced at token.intelligence (0.03), below transaction.explain (0.05).',
    supportedNetworks: ['solana-mainnet-beta'],
    output: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['proven', 'contradicted', 'unproven'],
          description: '`unproven` means the chain could not settle it yet, never that it is wrong.',
        },
        signature: { type: 'string' },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              term: {
                type: 'string',
                enum: ['landed', 'recipient', 'mint', 'amount', 'tokenAccount', 'memo', 'deadline', 'payer'],
              },
              expected: { type: 'string' },
              observed: { type: ['string', 'null'] },
              holds: { type: ['boolean', 'null'] },
            },
            required: ['term', 'expected', 'observed', 'holds'],
          },
        },
        paid: { type: 'object' },
        at: { type: 'string' },
        slot: { type: 'number' },
        finality: { type: 'object' },
        note: { type: 'string' },
      },
      required: ['verdict', 'signature', 'checks', 'note'],
    },
  },
  {
    tool: 'mesh',
    title: 'Multi-tool investigation with an evidence trail',
    category: 'Intelligence',
    price: 0.08,
    summary:
      'One subject, one stated objective — identify, holdings, activity, settlement, payment, safety or liveness — answered by a searched sequence of up to 16 read-only calls, returning the facts, the exact path that proved them, and an explicit list of what could not be proved and why.',
    customerValue:
      'A multi-step answer whose gaps are named instead of guessed over, and which is reproducible: two runs against the same chain state take the same path, and every step records the call and arguments that produced it.',
    pricing:
      'Up to eight calls by default, sixteen at most, for one flat price. Priced at contract.inspect (0.08), below research.asset (0.10).',
    supportedNetworks: ['solana-mainnet-beta', 'ethereum-mainnet', 'base-mainnet', 'arbitrum-mainnet'],
    output: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        subject: { type: 'string' },
        verdict: {
          type: 'string',
          enum: ['answered', 'partial', 'unanswerable', 'planned'],
          description: 'About the evidence, never about the subject.',
        },
        calls: { type: 'number' },
        path: { type: 'array', description: 'Each step: tool, exact arguments, facts proved, reward.' },
        facts: { type: 'object' },
        unproven: {
          type: 'array',
          items: { type: 'object', properties: { fact: { type: 'string' }, why: { type: 'string' } }, required: ['fact', 'why'] },
        },
        sigma: { type: 'object' },
        completeness,
      },
      required: ['objective', 'subject', 'verdict', 'calls', 'path', 'facts', 'unproven'],
    },
  },
];

/** One service, in the shape the exchange asked for. */
export interface SellerListing {
  id: string;
  tool: string;
  title: string;
  category: ExchangeCategory;
  summary: string;
  customer_value: string;
  price: number;
  currency: 'USDC';
  payment_network: string;
  accepted_assets: Array<{ symbol: string; mint: string; network: string }>;
  supported_target_networks: string[];
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  execution: { protocol: 'MCP'; endpoint: string; tool: string; read_only: true };
  pricing_basis: string;
}

export interface SellerMetadata {
  seller: typeof SELLER;
  services: SellerListing[];
}

/**
 * Build the metadata the exchange publishes from.
 *
 * Throws rather than lists when a service names a tool that is not in the
 * catalogue or is not read-only: a listing for either would be selling
 * something this server does not do, or should not do on a stranger's behalf.
 */
export function sellerMetadata(): SellerMetadata {
  const services = SPECS.map((spec): SellerListing => {
    const tool = TOOLS_BY_NAME.get(spec.tool);
    if (!tool) {
      throw new SingularityError('LISTING_INVALID', `A listing names \`${spec.tool}\`, which is not in the tool catalogue.`);
    }
    if (!tool.annotations.readOnlyHint || tool.name.startsWith('build_')) {
      throw new SingularityError(
        'LISTING_INVALID',
        `\`${spec.tool}\` builds transactions, and only read-only tools are sold through the exchange.`,
      );
    }

    return {
      id: `singularity.${spec.tool}`,
      tool: spec.tool,
      title: spec.title,
      category: spec.category,
      summary: spec.summary,
      customer_value: spec.customerValue,
      price: spec.price,
      currency: 'USDC',
      payment_network: SELLER.payoutNetwork,
      accepted_assets: [{ symbol: 'USDC', mint: USDC_MINT, network: SELLER.payoutNetwork }],
      supported_target_networks: spec.supportedNetworks,
      input_schema: shapeToJsonSchema(tool.shape),
      output_schema: spec.output,
      execution: { protocol: 'MCP', endpoint: SELLER.endpoint, tool: spec.tool, read_only: true },
      pricing_basis: spec.pricing,
    };
  });

  return { seller: SELLER, services };
}
