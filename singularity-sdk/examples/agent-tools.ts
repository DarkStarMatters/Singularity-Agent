/**
 * The tool catalogue in three shapes, with a policy hook in front.
 *
 *   npx tsx singularity-sdk/examples/agent-tools.ts
 *
 * No model is called here — this shows the pieces a tool-use loop needs and
 * what they contain, which is the part that is hard to see from documentation.
 */

import { anthropicTools, createExecutor, functionTools, mcpTools, TOOLS } from '../src/index.js';

// ── the same tools, three ways ───────────────────────────────────────────
console.log(`${TOOLS.length} tools in the catalogue.\n`);

const [anthropic] = anthropicTools({ only: ['balance'] });
const [fn] = functionTools({ only: ['balance'] });
const [mcp] = mcpTools({ only: ['balance'] });

console.log('Anthropic Messages API:');
console.log(`  { name: "${anthropic?.name}", input_schema: { type: "${anthropic?.input_schema['type']}", … } }`);
console.log('OpenAI-style function calling:');
console.log(`  { type: "function", function: { name: "${fn?.function.name}", parameters: { … } } }`);
console.log('MCP tools/list:');
console.log(`  { name: "${mcp?.name}", annotations: { readOnlyHint: ${mcp?.annotations.readOnlyHint} } }`);

// All three descriptions are the same string, from one place. That is the
// property this bridge exists to have — change the catalogue and no copy is
// left saying the old thing.
console.log(
  `\nSame description in all three: ${
    anthropic?.description === fn?.function.description && fn?.function.description === mcp?.description
  }`,
);

// ── an executor with a policy ────────────────────────────────────────────
const agent = createExecutor({
  selection: { only: ['chains', 'resolve', 'balance', 'portfolio'] },

  before(name, input) {
    console.log(`  → ${name}(${JSON.stringify(input)})`);

    // The kind of rule that belongs in code rather than in a prompt. A model
    // can be talked into anything it reads — a token name, a memo, an ENS
    // record — so what it is not allowed to do goes here.
    if (name === 'portfolio' && !input['chains']) {
      throw Object.assign(new Error('portfolio needs an explicit `chains` list in this app.'), {
        code: 'POLICY',
      });
    }
  },

  after(result) {
    console.log(result.isError ? `  ← ${result.error?.code}` : `  ← ok`);
  },
});

async function main(): Promise<void> {
  console.log(`\nExecutor exposes: ${agent.tools.map((t) => t.name).join(', ')}\n`);

  // 1. A tool that was never offered. Refused by name rather than merely
  //    absent from the list — a model can name a tool it was not given.
  const notOffered = await agent.run('build_transfer', { to: '0x1', amount: '1' });
  console.log(`     ${notOffered.error?.message}\n`);

  // 2. Refused by policy. The tool never ran.
  const refused = await agent.run('portfolio', { address: 'vitalik.eth' });
  console.log(`     ${refused.error?.message}\n`);

  // 3. Bad arguments, caught before any operation sees them. The caller on
  //    this path is a model improvising JSON, and nothing else validates it.
  const invalid = await agent.run('balance', { chain: 'ethereum' });
  console.log(`     ${invalid.error?.code}: ${invalid.error?.message}\n`);

  // 4. A real read.
  const ok = await agent.run('chains', { family: 'cosmos' });
  const chains = ok.result as Array<{ id: string; nativeSymbol?: string }>;
  console.log(`     ${chains.map((c) => c.id).join(', ')}\n`);

  // 5. A failure from the chain itself — returned as a value, with the hint
  //    intact. A model that sees a thrown exception sees a crashed turn; the
  //    hints in this codebase are written for exactly this reader.
  const bad = await agent.run('balance', { address: 'definitely-not-an-address', chain: 'ethereum' });
  console.log(`     ${bad.error?.code}: ${bad.error?.message}`);
  if (bad.error?.hint) console.log(`     hint: ${bad.error.hint}`);

  console.log(`
In a real loop:

    const response = await anthropic.messages.create({ model, tools, messages });

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = await agent.run(block.name, block.input);
      messages.push({ role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: block.id,
        is_error: result.isError,
        content: JSON.stringify(result.error ?? result.result),
      }]});
    }

Pass the result through whole. The completeness envelope on it is what stops a
model reporting "this wallet holds nothing" when nothing was checked.
`);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
