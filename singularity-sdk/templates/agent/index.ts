/**
 * A blockchain agent: the tool catalogue, a policy hook, and a signer stub.
 *
 * This is the shape of an application that lets a model answer questions about
 * chain state and — if you finish the signer — act on them.
 *
 * Read `signer.ts` before you do that. It is a stub that throws, and it is a
 * stub on purpose: a working keypair signer sitting here commented out is one
 * uncomment away from a private key in a public repository. The type is right
 * and the behaviour is wrong, which is the safer way to be incomplete.
 *
 * The policy hook in `createExecutor` is the part to actually think about. A
 * model choosing tools is a model that can be talked into choosing them, by
 * anything it reads — a token name, a memo field, an ENS record. Everything
 * this agent is not allowed to do belongs in `before`, not in the prompt.
 */

import { createExecutor, createSingularity } from 'singularity-sdk';

// Read-only. Swap in `{ signer }` from ./signer.ts once you have implemented
// it, and `sdk.write` becomes callable — until then it is a compile error,
// which is the intended amount of friction.
const sdk = createSingularity({ chain: 'ethereum' });

const agent = createExecutor({
  // Give the model what this application needs and nothing else. Every extra
  // tool is extra surface.
  selection: {
    only: ['chains', 'resolve', 'balance', 'portfolio', 'transaction', 'history', 'token_identity'],
  },

  /**
   * Policy. Runs after the model picked a tool and before the tool runs —
   * the only point where both the choice and its arguments are known.
   */
  before(name, input) {
    console.log(`  → ${name}(${JSON.stringify(input)})`);

    // An example of the kind of rule that belongs here rather than in a
    // prompt: cap how much history one call can pull, whatever was asked for.
    if (name === 'history' && typeof input['limit'] === 'number' && input['limit'] > 50) {
      return { ...input, limit: 50 };
    }

    // Throwing refuses the call. The model sees a refusal it can read and
    // respond to, not a crashed turn.
    if (name === 'portfolio' && !input['chains']) {
      throw Object.assign(new Error('portfolio needs an explicit `chains` list in this app.'), {
        code: 'POLICY',
      });
    }
  },

  after(result) {
    if (result.isError) console.log(`  ← ${result.error?.code}: ${result.error?.message}`);
  },
});

async function main(): Promise<void> {
  // The tool definitions, in the shape the Anthropic Messages API wants.
  // `agent.functions()` gives the OpenAI-style shape instead; `mcpTools()`
  // gives MCP descriptors. All three are derived from one catalogue.
  const tools = agent.anthropic();
  console.log(`${tools.length} tools available: ${tools.map((t) => t.name).join(', ')}\n`);

  // Where a real tool-use loop goes. The pieces you need are all here: `tools`
  // to send with the request, and `agent.run(name, input)` to execute whatever
  // the model asks for. Results come back as values — never thrown — so a
  // failed call becomes a message the model can recover from:
  //
  //   const response = await anthropic.messages.create({ model, tools, messages });
  //   for (const block of response.content) {
  //     if (block.type !== 'tool_use') continue;
  //     const result = await agent.run(block.name, block.input);
  //     messages.push({ role: 'user', content: [{
  //       type: 'tool_result',
  //       tool_use_id: block.id,
  //       is_error: result.isError,
  //       content: JSON.stringify(result.error ?? result.result),
  //     }]});
  //   }
  //
  // One demonstration call, so this template does something when you run it:
  const result = await agent.run('balance', {
    address: 'vitalik.eth',
    chain: 'ethereum',
    includeTokens: true,
  });

  if (result.isError) {
    console.error(`\n${result.error?.message}`);
    if (result.error?.hint) console.error(result.error.hint);
    return;
  }

  // What a model receives. Note the `tokenCompleteness` field — pass it
  // through to the model rather than stripping it. It is the difference
  // between "holds nothing" and "nothing was checked", and a model that never
  // sees it will state the first when the second is true.
  console.log(`\n${JSON.stringify(result.result, null, 2).slice(0, 1200)}`);

  // A read the client does directly, with no model involved.
  const live = await sdk.liveness(['ethereum']);
  console.log(`\nethereum: ${live[0]?.status ?? 'unknown'}`);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
