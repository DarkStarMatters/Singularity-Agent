import { describe, it, expect } from 'vitest';
import { COMMANDS } from '../src/telegram/commands.js';
import { parseCommand, tokenizeArgs } from '../src/telegram/bot.js';
import { MeshMemory, meshMemory } from '../src/telegram/mesh-memory.js';
import { runMesh, type MeshResult } from '../src/mesh/search.js';
import { meshArtFacts } from '../src/art/mesh-art.js';
import { verifyMeshArt } from '../src/art/mesh-raster.js';
import { SingularityError } from '../src/core/errors.js';

/**
 * `/nft #1 "series name"` is the command as it was asked for, and almost
 * everything that can go wrong with it is in the parsing.
 *
 * A series name is the first argument this bot has ever taken that is prose
 * rather than an address, so the whitespace split it used for two years does
 * not survive contact with it — and neither does a straight-quote-only parser,
 * because phone keyboards substitute typographic quotes without asking. Both
 * are pinned below.
 */

const SOL = 'So11111111111111111111111111111111111111112';

const FIXTURES: Record<string, unknown> = {
  resolve: { input: SOL, kind: 'address', address: SOL, chains: ['solana'], family: 'svm', note: 'base58' },
  mint_audit: { chain: 'solana', mint: SOL, program: 'spl-token', decimals: 9, extensions: [] },
  token_identity: { chain: 'solana', mint: SOL, symbol: 'SOL', immutable: { metadata: 'mutable', document: false, note: '' } },
  inspect_exit: { mint: SOL, chain: 'solana', canExit: true, underThirdPartyControl: false, risks: [] },
};

function aRun(): Promise<MeshResult> {
  return runMesh({ subject: SOL, objective: 'safety', chain: 'solana' }, async (tool) => {
    const value = FIXTURES[tool];
    if (value === undefined) throw new SingularityError('NO_FIXTURE', `no fixture for ${tool}`);
    return value;
  });
}

function ctx(chatId: number, args: string[]) {
  return { args, chatId, chatType: 'private' as const, config: {} as never };
}

describe('command arguments, now that one of them is prose', () => {
  it('still splits ordinary arguments on whitespace', () => {
    expect(tokenizeArgs('vitalik.eth ethereum')).toEqual(['vitalik.eth', 'ethereum']);
    expect(tokenizeArgs('   ')).toEqual([]);
  });

  it('keeps a quoted name in one piece', () => {
    expect(tokenizeArgs('#1 "Genesis Mesh"')).toEqual(['#1', 'Genesis Mesh']);
  });

  it('keeps a name in the curly quotes a phone actually types', () => {
    // Both platforms substitute these as you type. A parser that knows only
    // the straight pair reads this as two arguments with punctuation stuck on.
    expect(tokenizeArgs('#1 “Genesis Mesh”')).toEqual(['#1', 'Genesis Mesh']);
    expect(tokenizeArgs('#2 ‘First Light’')).toEqual(['#2', 'First Light']);
  });

  it('takes the rest of the line when a quote is never closed', () => {
    expect(tokenizeArgs('#1 "Genesis Mesh')).toEqual(['#1', 'Genesis Mesh']);
  });

  it('reaches the command through the full parse', () => {
    expect(parseCommand('/nft #1 "Genesis Mesh"')).toEqual({
      name: 'nft',
      args: ['#1', 'Genesis Mesh'],
    });
    expect(parseCommand('/nft@singularitybot #3 "Second Pass"')?.args).toEqual(['#3', 'Second Pass']);
  });
});

describe('the memory /nft draws from', () => {
  it('hands back the run the chat last made, and nobody else’s', async () => {
    const memory = new MeshMemory();
    const result = await aRun();
    memory.remember(11, result);

    expect(memory.recall(11)?.result).toBe(result);
    expect(memory.recall(12)).toBeUndefined();
  });

  it('will not remember a plan, which called nothing', async () => {
    const memory = new MeshMemory();
    const plan = await runMesh(
      { subject: SOL, objective: 'safety', chain: 'solana', plan: true },
      async () => ({}),
    );

    memory.remember(1, plan);
    expect(memory.recall(1)).toBeUndefined();
  });

  it('evicts the least recently used chat rather than the first one seen', async () => {
    const memory = new MeshMemory(2);
    const result = await aRun();

    memory.remember(1, result);
    memory.remember(2, result);
    // Touching 1 again makes 2 the oldest.
    memory.remember(1, result);
    memory.remember(3, result);

    expect(memory.size).toBe(2);
    expect(memory.recall(1)).toBeDefined();
    expect(memory.recall(3)).toBeDefined();
    expect(memory.recall(2)).toBeUndefined();
  });
});

describe('/nft', () => {
  it('says there is nothing to draw rather than drawing something else', async () => {
    meshMemory.forget(9001);

    await expect(COMMANDS.get('nft')!.run(ctx(9001, ['#1', 'Genesis Mesh']))).rejects.toMatchObject({
      code: 'NO_MESH_RUN',
    });
  });

  it('needs an edition and a series, and says which is missing', async () => {
    meshMemory.remember(9002, await aRun());

    await expect(COMMANDS.get('nft')!.run(ctx(9002, ['Genesis Mesh']))).rejects.toMatchObject({
      message: expect.stringContaining('edition'),
    });
    await expect(COMMANDS.get('nft')!.run(ctx(9002, ['#1']))).rejects.toMatchObject({
      message: expect.stringContaining('series'),
    });
  });

  it('returns a document, not a photo, so the bytes stay checkable', async () => {
    const result = await aRun();
    meshMemory.remember(9003, result);

    const reply = (await COMMANDS.get('nft')!.run(ctx(9003, ['#1', 'Genesis Mesh']))) as {
      document: Uint8Array;
      filename: string;
      caption: string;
    };

    expect(reply.document).toBeInstanceOf(Uint8Array);
    expect([...reply.document.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(reply.filename).toBe('genesis-mesh-1.png');

    // The picture the chat receives is the picture the caption describes.
    const facts = meshArtFacts(result, { series: 'Genesis Mesh', edition: 1 });
    expect(verifyMeshArt(facts, reply.document)).toBe(true);
    expect(reply.caption).toContain('Genesis Mesh #1');
    expect(reply.caption).toContain(facts.digest.slice(0, 32));
  }, 20_000);

  it('accepts a bare edition number as readily as a hashed one', async () => {
    meshMemory.remember(9004, await aRun());

    const reply = (await COMMANDS.get('nft')!.run(ctx(9004, ['2', 'First', 'Light']))) as {
      filename: string;
    };

    expect(reply.filename).toBe('first-light-2.png');
  }, 20_000);

  it('is listed in the menu the bot registers', () => {
    expect(COMMANDS.get('nft')).toBeTruthy();
    expect(COMMANDS.get('mint_art')).toBe(COMMANDS.get('nft'));
  });
});
