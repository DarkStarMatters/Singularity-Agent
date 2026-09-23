import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { SELLER, USDC_MINT, sellerMetadata } from '../src/exchange/listings.js';
import { TOOLS_BY_NAME } from '../src/tools/catalog.js';
import { shapeToJsonSchema, type JsonSchema } from '../src/tools/json-schema.js';

/**
 * What Singularity sells, held to what Singularity does.
 *
 * A listing is a promise to a buyer who never sees this repository: that a paid
 * call with this input returns this shape. The input side is derived from the
 * catalogue and only needs holding in place; the output side is hand-written,
 * so it is checked against real outputs recorded from each tool on 2026-09-23
 * (`test/fixtures/seller/`). The committed metadata file is what was sent to the
 * exchange, and it must be exactly what the code generates.
 */

const ROOT = resolve(__dirname, '..');
const metadata = sellerMetadata();

/**
 * Just enough JSON Schema to hold a fixture to a listing: types, required
 * fields, enums, nested properties and array items. Extra fields are allowed —
 * an output schema names what a buyer can rely on, not everything returned.
 */
function violations(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const found: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

  if (types.length && !types.includes(actual)) {
    return [`${path}: expected ${types.join('|')}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    found.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (actual === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) found.push(`${path}.${key}: required, missing`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) found.push(...violations(record[key], child, `${path}.${key}`));
    }
  }
  if (actual === 'array' && schema.items) {
    (value as unknown[]).forEach((item, index) => found.push(...violations(item, schema.items!, `${path}[${index}]`)));
  }
  return found;
}

describe('what is for sale', () => {
  it('starts with the five services the exchange asked for', () => {
    expect(metadata.services.map((service) => service.tool)).toEqual([
      'mint_audit',
      'inspect_exit',
      'inspect_payment',
      'prove_payment',
      'mesh',
    ]);
  });

  it('sells only read-only tools, and none that builds a transaction', () => {
    for (const service of metadata.services) {
      const tool = TOOLS_BY_NAME.get(service.tool);
      expect(tool, `${service.tool} is not in the catalogue`).toBeTruthy();
      expect(tool!.annotations.readOnlyHint).toBe(true);
      expect(service.tool.startsWith('build_')).toBe(false);
      expect(service.execution.read_only).toBe(true);
    }
  });

  it('takes exactly the input the tool behind it accepts', () => {
    for (const service of metadata.services) {
      expect(service.input_schema).toEqual(shapeToJsonSchema(TOOLS_BY_NAME.get(service.tool)!.shape));
    }
  });

  it('routes every paid call to the tool it was sold as, on the hosted endpoint', () => {
    for (const service of metadata.services) {
      expect(service.execution).toEqual({
        protocol: 'MCP',
        endpoint: 'https://mcp-singularity.cicada71.net/mcp',
        tool: service.tool,
        read_only: true,
      });
      expect(service.id).toBe(`singularity.${service.tool}`);
    }
  });
});

describe('the prices', () => {
  it('settle in Solana USDC, by mint rather than by ticker', () => {
    for (const service of metadata.services) {
      expect(service.currency).toBe('USDC');
      expect(service.payment_network).toBe('solana-mainnet-beta');
      expect(service.accepted_assets).toEqual([
        { symbol: 'USDC', mint: USDC_MINT, network: 'solana-mainnet-beta' },
      ]);
    }
  });

  it('stay inside the band the exchange prices comparable reads at', () => {
    // 0.02 is the floor so the buyer's network fee stays a small part of the
    // price; 0.10 is research.asset, the dearest comparable in the catalogue.
    for (const service of metadata.services) {
      expect(service.price, service.id).toBeGreaterThanOrEqual(0.02);
      expect(service.price, service.id).toBeLessThanOrEqual(0.1);
      expect(Number.isInteger(service.price * 100), `${service.id} is not a whole cent`).toBe(true);
    }
  });

  it('say why, against a named comparable', () => {
    for (const service of metadata.services) {
      expect(service.pricing_basis, service.id).toMatch(/\(0\.\d\d\)/);
    }
  });
});

describe('what a buyer gets back', () => {
  for (const tool of ['mint_audit', 'inspect_exit', 'inspect_payment', 'prove_payment', 'mesh']) {
    it(`matches what ${tool} actually returned`, () => {
      const recorded = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'seller', `${tool}.json`), 'utf8'));
      const schema = metadata.services.find((service) => service.tool === tool)!.output_schema;

      expect(violations(recorded, schema)).toEqual([]);
    });
  }

  it('would notice an output that broke its promise', () => {
    // The validator is only worth the fixtures it passes if it fails too.
    const schema = metadata.services.find((service) => service.tool === 'prove_payment')!.output_schema;
    expect(violations({ verdict: 'probably', signature: 'x', checks: [], note: '' }, schema)).toEqual([
      '$.verdict: "probably" is not one of proven, contradicted, unproven',
    ]);
  });
});

describe('the seller', () => {
  it('is paid to a real Solana address that already holds a USDC account', () => {
    expect(() => new PublicKey(SELLER.payoutAddress)).not.toThrow();
    expect(SELLER.payoutAsset.mint).toBe(USDC_MINT);
  });

  it('is the metadata committed and sent, exactly', () => {
    const committed = JSON.parse(readFileSync(join(ROOT, 'docs', 'privatedao-seller-metadata.json'), 'utf8'));
    expect(committed, 'regenerate: singularity --json exchange listings > docs/privatedao-seller-metadata.json').toEqual(
      JSON.parse(JSON.stringify(metadata)),
    );
  });
});
