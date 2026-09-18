import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { shapeToJsonSchema, toJsonSchema, isOptional } from '../src/tools/json-schema.js';
import { TOOLS, getTool } from '../src/tools/catalog.js';
import { toolSchemas, runToolCall } from '../src/grok/tools.js';
import { ConversationMemory } from '../src/grok/memory.js';
import { GrokAgent, sanitizeName } from '../src/grok/agent.js';
import type { AssistantMessage, ChatMessage, GrokClient, ToolCall } from '../src/grok/client.js';
import { systemPromptFor } from '../src/grok/persona.js';
import {
  decideEngagement,
  isAnonymousAdmin,
  isFromAnotherBot,
  mentionsBot,
  repliesToBot,
  stripBotHandle,
  pingFor,
  GROUP_ANONYMOUS_BOT_ID,
} from '../src/telegram/engage.js';
import { sanitizeModelHtml } from '../src/telegram/html.js';
import { stripHandles, fitReply, REPLY_LIMIT } from '../src/x/listener.js';
import { cursorFor } from '../src/x/state.js';
import { TelegramApi, type TelegramMessage } from '../src/telegram/api.js';

describe('zod to JSON Schema', () => {
  it('marks only non-optional arguments required', () => {
    const schema = shapeToJsonSchema({
      chain: z.string(),
      token: z.string().optional(),
    });

    expect(schema.required).toEqual(['chain']);
    expect(schema.properties?.chain?.type).toBe('string');
  });

  it('keeps the description, which is what the model reads', () => {
    const schema = toJsonSchema(z.string().describe('Chain id or alias.'));
    expect(schema.description).toBe('Chain id or alias.');
  });

  it('keeps a description written outside .optional()', () => {
    const schema = toJsonSchema(z.string().optional().describe('Optional chain.'));
    expect(schema).toMatchObject({ type: 'string', description: 'Optional chain.' });
  });

  it('renders arrays, enums and scalar unions', () => {
    expect(toJsonSchema(z.array(z.string()))).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
    expect(toJsonSchema(z.enum(['evm', 'svm']))).toMatchObject({
      type: 'string',
      enum: ['evm', 'svm'],
    });
    expect(toJsonSchema(z.union([z.string(), z.number()]))).toMatchObject({
      type: ['string', 'number'],
    });
  });

  it('detects optionality', () => {
    expect(isOptional(z.string().optional())).toBe(true);
    expect(isOptional(z.string())).toBe(false);
  });

  it('throws on a type it cannot render rather than emitting an empty schema', () => {
    // An empty schema would read to a model as "this takes anything".
    expect(() => toJsonSchema(z.object({ a: z.string() }), 'thing')).toThrow(/Unsupported/);
  });

  it('omits required entirely when every argument is optional', () => {
    expect(shapeToJsonSchema({ query: z.string().optional() }).required).toBeUndefined();
  });
});

describe('tool catalogue', () => {
  it('converts every tool to a usable function schema', () => {
    const schemas = toolSchemas();
    expect(schemas).toHaveLength(TOOLS.length);

    for (const schema of schemas) {
      expect(schema.function.name).toBeTruthy();
      expect(schema.function.description.length).toBeGreaterThan(40);
      expect(schema.function.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('gives the same tools MCP exposes', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'balance',
      'block',
      'build_burn',
      'build_transfer',
      'chains',
      'decode',
      'fees',
      'history',
      'mint_audit',
      'portfolio',
      'read_contract',
      'resolve',
      'token_identity',
      'transaction',
      'verify_burn',
    ]);
  });

  it('marks every tool read-only', () => {
    for (const tool of TOOLS) expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it('looks a tool up by name', () => {
    expect(getTool('fees')?.title).toBe('Estimate current fees');
    expect(getTool('nope')).toBeUndefined();
  });
});

function call(name: string, args: unknown): ToolCall {
  return {
    id: 'call_1',
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

describe('running a tool call', () => {
  it('runs a real tool and returns JSON', async () => {
    const run = await runToolCall(call('chains', { family: 'cosmos' }));

    expect(run.ok).toBe(true);
    const chains = JSON.parse(run.result) as Array<{ family: string }>;
    expect(chains.every((c) => c.family === 'cosmos')).toBe(true);
  });

  it('hands an unknown tool back a list of the real ones', async () => {
    const run = await runToolCall(call('teleport', {}));

    expect(run.ok).toBe(false);
    expect(JSON.parse(run.result)).toMatchObject({ error: 'UNKNOWN_TOOL' });
    expect(JSON.parse(run.result).hint).toContain('balance');
  });

  it('survives arguments that are not JSON', async () => {
    const run = await runToolCall(call('fees', 'chain=base'));
    expect(JSON.parse(run.result)).toMatchObject({ error: 'BAD_ARGUMENTS' });
  });

  it('treats an empty argument string as no arguments', async () => {
    const run = await runToolCall(call('chains', ''));
    expect(run.ok).toBe(true);
  });

  it('returns a tool error with its hint instead of throwing', async () => {
    const run = await runToolCall(call('fees', { chain: 'not-a-chain' }));

    expect(run.ok).toBe(false);
    const payload = JSON.parse(run.result) as { error: string; hint: string };
    expect(payload.error).toBe('UNKNOWN_CHAIN');
    // The hint is what lets the model correct itself on the next round.
    expect(payload.hint).toBeTruthy();
  });
});

describe('conversation memory', () => {
  it('keeps the recent turns and drops the oldest', () => {
    const memory = new ConversationMemory({ maxTurns: 4 });
    for (let i = 0; i < 6; i++) {
      memory.append('chat', [{ role: 'user', content: `m${i}` }]);
    }

    const kept = memory.get('chat').map((m) => m.content);
    expect(kept).toEqual(['m2', 'm3', 'm4', 'm5']);
  });

  it('never leaves a dangling tool result at the front', () => {
    const memory = new ConversationMemory({ maxTurns: 2 });
    memory.append('chat', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'tool', content: '{}', tool_call_id: 'x' },
      { role: 'assistant', content: 'c' },
    ]);

    expect(memory.get('chat')[0]?.role).not.toBe('tool');
  });

  it('forgets a conversation past its ttl', () => {
    const memory = new ConversationMemory({ ttlMs: 1_000 });
    memory.append('chat', [{ role: 'user', content: 'hi' }], 0);

    expect(memory.get('chat', 500)).toHaveLength(1);
    expect(memory.get('chat', 2_000)).toHaveLength(0);
  });

  it('evicts the least recently used conversation past the cap', () => {
    const memory = new ConversationMemory({ maxConversations: 2 });
    memory.append('a', [{ role: 'user', content: '1' }]);
    memory.append('b', [{ role: 'user', content: '2' }]);
    memory.append('a', [{ role: 'user', content: '3' }]);
    memory.append('c', [{ role: 'user', content: '4' }]);

    expect(memory.size).toBe(2);
    // "a" was touched more recently than "b", so "b" is the one to go.
    expect(memory.get('b')).toHaveLength(0);
    expect(memory.get('a').length).toBeGreaterThan(0);
  });

  it('clears one conversation on request', () => {
    const memory = new ConversationMemory();
    memory.append('chat', [{ role: 'user', content: 'hi' }]);
    memory.clear('chat');

    expect(memory.get('chat')).toHaveLength(0);
  });
});

/** A scripted model: each entry is one turn's reply. */
function fakeClient(turns: AssistantMessage[]): {
  client: GrokClient;
  sent: ChatMessage[][];
  toolsOffered: boolean[];
} {
  const sent: ChatMessage[][] = [];
  const toolsOffered: boolean[] = [];
  let index = 0;

  const client = {
    async complete(messages: ChatMessage[], options: { tools?: unknown[] } = {}) {
      sent.push(structuredClone(messages));
      toolsOffered.push(Boolean(options.tools?.length));
      return turns[Math.min(index++, turns.length - 1)]!;
    },
  } as unknown as GrokClient;

  return { client, sent, toolsOffered };
}

const say = (content: string): AssistantMessage => ({ content, toolCalls: [] });
const wants = (name: string, args: unknown): AssistantMessage => ({
  content: '',
  toolCalls: [call(name, args)],
});

describe('agent loop', () => {
  it('answers directly when no tool is needed', async () => {
    const { client, sent } = fakeClient([say('Base is an L2.')]);
    const agent = new GrokAgent(client, { system: 'sys' });

    const reply = await agent.respond('chat', 'what is base?');

    expect(reply.text).toBe('Base is an L2.');
    expect(reply.rounds).toBe(0);
    expect(sent[0]?.[0]).toMatchObject({ role: 'system', content: 'sys' });
  });

  it('runs a tool, then answers from the result', async () => {
    const { client, sent } = fakeClient([wants('chains', { family: 'cosmos' }), say('Four of them.')]);
    const agent = new GrokAgent(client, { system: 'sys' });

    const reply = await agent.respond('chat', 'which cosmos chains?');

    expect(reply.rounds).toBe(1);
    expect(reply.toolRuns[0]?.name).toBe('chains');
    expect(reply.text).toBe('Four of them.');
    // The tool result must reach the model, or it answers from nothing.
    expect(sent[1]?.some((m) => m.role === 'tool')).toBe(true);
  });

  it('demands prose on the last round by withholding the tools', async () => {
    const { client, toolsOffered } = fakeClient([wants('chains', {})]);
    const agent = new GrokAgent(client, { system: 'sys', maxToolRounds: 2 });

    const reply = await agent.respond('chat', 'loop forever');

    expect(reply.rounds).toBe(2);
    // Rounds 1 and 2 were offered tools; the final call was not.
    expect(toolsOffered).toEqual([true, true, false]);
    expect(reply.text).toBeTruthy();
  });

  it('says something rather than nothing when the model returns empty', async () => {
    const { client } = fakeClient([say('')]);
    const agent = new GrokAgent(client, { system: 'sys' });

    expect((await agent.respond('chat', 'hi')).text).toMatch(/could not/i);
  });

  it('remembers the previous turn but not the tool traffic', async () => {
    const { client, sent } = fakeClient([
      wants('chains', {}),
      say('First.'),
      say('Second.'),
    ]);
    const agent = new GrokAgent(client, { system: 'sys' });

    await agent.respond('chat', 'one');
    await agent.respond('chat', 'two');

    const second = sent[2]!;
    expect(second.map((m) => m.content)).toContain('First.');
    expect(second.some((m) => m.role === 'tool')).toBe(false);
  });

  it('keeps conversations apart', async () => {
    const { client, sent } = fakeClient([say('a'), say('b')]);
    const agent = new GrokAgent(client, { system: 'sys' });

    await agent.respond('chat-1', 'one');
    await agent.respond('chat-2', 'two');

    expect(sent[1]!.map((m) => m.content)).not.toContain('one');
  });

  it('forgets on request', async () => {
    const { client, sent } = fakeClient([say('a'), say('b')]);
    const agent = new GrokAgent(client, { system: 'sys' });

    await agent.respond('chat', 'one');
    agent.forget('chat');
    await agent.respond('chat', 'two');

    expect(sent[1]!.map((m) => m.content)).not.toContain('one');
  });

  it('labels the speaker so a group thread is not one voice', async () => {
    const { client, sent } = fakeClient([say('ok')]);
    const agent = new GrokAgent(client, { system: 'sys' });

    await agent.respond('chat', 'hi', 'alice');
    expect(sent[0]!.at(-1)).toMatchObject({ role: 'user', name: 'alice' });
  });

  it('sanitizes a display name the API would reject', () => {
    expect(sanitizeName('🔥 Crypto King 🔥')).toBe('Crypto_King');
    expect(sanitizeName('🔥')).toBe('user');
  });
});

describe('persona', () => {
  it('states the no-keys constraint on every surface', () => {
    for (const platform of ['telegram', 'x', 'plain'] as const) {
      expect(systemPromptFor(platform)).toContain('no private keys');
    }
  });

  it('gives X a character limit and Telegram the HTML subset', () => {
    expect(systemPromptFor('x')).toMatch(/260 characters/);
    expect(systemPromptFor('telegram')).toContain('<code>');
    expect(systemPromptFor('plain')).not.toMatch(/260 characters/);
  });
});

function tgMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 0,
    chat: { id: -100, type: 'supergroup' },
    from: { id: 7, is_bot: false, username: 'alice' },
    ...overrides,
  } as TelegramMessage;
}

describe('telegram engagement', () => {
  it('answers everything in a DM', () => {
    const message = tgMessage({ chat: { id: 5, type: 'private' }, text: 'hey' });
    expect(decideEngagement(message, 'SingularityBot', 99, false)).toMatchObject({
      engage: true,
      reason: 'private',
    });
  });

  it('ignores ordinary group chatter', () => {
    const message = tgMessage({ text: 'anyone seen the match' });
    expect(decideEngagement(message, 'SingularityBot', 99, false).engage).toBe(false);
  });

  it('answers a group @mention and strips the handle', () => {
    const text = '@SingularityBot what is gas on base?';
    const message = tgMessage({
      text,
      entities: [{ type: 'mention', offset: 0, length: '@SingularityBot'.length }],
    });

    const decision = decideEngagement(message, 'SingularityBot', 99, false);
    expect(decision).toMatchObject({ engage: true, reason: 'mention' });
    expect(decision.text).toBe('what is gas on base?');
  });

  it('does not treat an unparsed handle in prose as a mention', () => {
    // No entity means Telegram did not see it as a mention — e.g. inside code.
    const message = tgMessage({ text: 'the @SingularityBot thing' });
    expect(mentionsBot(message, 'SingularityBot')).toBe(false);
  });

  it('ignores a mention of a different bot', () => {
    const message = tgMessage({
      text: '@OtherBot hello',
      entities: [{ type: 'mention', offset: 0, length: '@OtherBot'.length }],
    });
    expect(mentionsBot(message, 'SingularityBot')).toBe(false);
  });

  it('recognizes a mention of a bot with no username', () => {
    const message = tgMessage({
      text: 'Singularity hi',
      entities: [
        { type: 'text_mention', offset: 0, length: 11, user: { id: 99, is_bot: true } },
      ],
    });
    expect(mentionsBot(message, '', 99)).toBe(true);
  });

  it('answers a reply to its own message', () => {
    const message = tgMessage({
      text: 'and on arbitrum?',
      reply_to_message: tgMessage({ from: { id: 99, is_bot: true }, text: 'Base: 0.01 ETH' }),
    });

    expect(decideEngagement(message, 'SingularityBot', 99, false)).toMatchObject({
      engage: true,
      reason: 'reply',
    });
  });

  it('does not answer a reply to a different bot', () => {
    const message = tgMessage({
      text: 'and on arbitrum?',
      reply_to_message: tgMessage({ from: { id: 1234, is_bot: true } }),
    });
    expect(repliesToBot(message, 99)).toBe(false);
  });

  it('does not answer a reply to another person', () => {
    const message = tgMessage({
      text: 'sure',
      reply_to_message: tgMessage({ from: { id: 8, is_bot: false } }),
    });
    expect(repliesToBot(message, 99)).toBe(false);
  });

  it('strips a trailing handle but leaves one mid-sentence', () => {
    expect(stripBotHandle('gas on base @SingularityBot', 'SingularityBot')).toBe('gas on base');
    expect(stripBotHandle('ask @SingularityBot about base', 'SingularityBot')).toBe(
      'ask @SingularityBot about base',
    );
  });

  it('pings by username in a group and not at all in a DM', () => {
    expect(pingFor(tgMessage())).toBe('@alice ');
    expect(pingFor(tgMessage({ chat: { id: 5, type: 'private' } }))).toBe('');
  });

  it('falls back to a first name when there is no username', () => {
    expect(pingFor(tgMessage({ from: { id: 7, is_bot: false, first_name: 'Bob' } }))).toBe('Bob, ');
  });
});

describe('anonymous group admins', () => {
  /** Exactly what Telegram sends when an admin posts as the group. */
  const anonymous = tgMessage({
    text: '/help',
    from: { id: GROUP_ANONYMOUS_BOT_ID, is_bot: true, username: 'GroupAnonymousBot' },
    sender_chat: { id: -1004313647053, type: 'supergroup', title: 'SingularityAgent' },
  });

  it('recognizes an anonymous admin as a person', () => {
    expect(isAnonymousAdmin(anonymous)).toBe(true);
    // This is the bug: is_bot is true, so a naive guard dropped the message.
    expect(anonymous.from?.is_bot).toBe(true);
    expect(isFromAnotherBot(anonymous)).toBe(false);
  });

  it('still ignores a genuine bot', () => {
    const realBot = tgMessage({
      text: '/help',
      from: { id: 555, is_bot: true, username: 'SomeOtherBot' },
    });

    expect(isFromAnotherBot(realBot)).toBe(true);
  });

  it('treats a normal user as a person', () => {
    expect(isFromAnotherBot(tgMessage({ text: 'hi' }))).toBe(false);
    expect(isAnonymousAdmin(tgMessage({ text: 'hi' }))).toBe(false);
  });

  it('does not ping back the pseudo-account Telegram invented', () => {
    // "@GroupAnonymousBot" would be wrong and would link to Telegram's own account.
    expect(pingFor(anonymous)).toBe('');
  });

  it('engages with a command from an anonymous admin', () => {
    expect(decideEngagement(anonymous, 'Singularityagenticbot', 99, true)).toMatchObject({
      engage: true,
      reason: 'command',
    });
  });
});

describe('update subscription', () => {
  it('asks Telegram for the update types the bot actually needs', async () => {
    // allowed_updates is a filter, not a hint: anything left out is never
    // delivered and there is no error to notice. Subscribing to `message`
    // alone made the bot deaf in channels and unable to tell whether it had
    // even been added to a chat.
    let sent: Record<string, unknown> | undefined;

    const api = new TelegramApi('123456:test');
    (api as unknown as { call: unknown }).call = async (
      _method: string,
      params: Record<string, unknown>,
    ) => {
      sent = params;
      return [];
    };

    await api.getUpdates(0, 1);

    expect(sent?.allowed_updates).toEqual([
      'message',
      'channel_post',
      'my_chat_member',
      // Approval buttons arrive as callback queries; without this the buttons
      // would spin forever and no post could ever be approved.
      'callback_query',
    ]);
  });
});

describe('telegram html sanitizing', () => {
  it('keeps the whitelisted tags', () => {
    expect(sanitizeModelHtml('<b>Base</b> costs <code>0.01</code>')).toBe(
      '<b>Base</b> costs <code>0.01</code>',
    );
  });

  it('escapes a tag that is not on the list', () => {
    expect(sanitizeModelHtml('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('falls back to plain text rather than sending unbalanced HTML', () => {
    // Telegram rejects the whole message for this, so the answer would be lost.
    const result = sanitizeModelHtml('<b>unclosed');
    expect(result).toBe('&lt;b&gt;unclosed');
  });

  it('rejects mis-nested tags', () => {
    expect(sanitizeModelHtml('<b><i>x</b></i>')).toContain('&lt;b&gt;');
  });

  it('keeps an http link and drops a javascript one', () => {
    expect(sanitizeModelHtml('<a href="https://x.com">x</a>')).toBe(
      '<a href="https://x.com/">x</a>',
    );
    expect(sanitizeModelHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('<a href');
  });

  it('escapes a stray angle bracket in prose', () => {
    expect(sanitizeModelHtml('gas < 1 gwei')).toBe('gas &lt; 1 gwei');
  });
});

describe('x reply shaping', () => {
  it('strips the handles X prepends to a reply', () => {
    expect(stripHandles('@SingularityAgnt @someone what is gas on base?', 'SingularityAgnt')).toBe(
      'what is gas on base?',
    );
  });

  it('leaves a handle that is part of the question', () => {
    expect(stripHandles('is @vitalik on base?', 'SingularityAgnt')).toBe('is @vitalik on base?');
  });

  it('passes a short reply through untouched', () => {
    expect(fitReply('Base gas is 0.01 gwei.')).toBe('Base gas is 0.01 gwei.');
  });

  it('cuts an over-long reply at a sentence boundary', () => {
    const text = `${'a'.repeat(200)}. ${'b'.repeat(200)}.`;
    const fitted = fitReply(text);

    expect(fitted.length).toBeLessThanOrEqual(REPLY_LIMIT);
    expect(fitted.endsWith('.')).toBe(true);
  });

  it('falls back to a word boundary with an ellipsis', () => {
    const fitted = fitReply(`${'word '.repeat(100)}`);

    expect(fitted.length).toBeLessThanOrEqual(REPLY_LIMIT);
    expect(fitted.endsWith('…')).toBe(true);
  });

  it('collapses the whitespace a model leaves behind', () => {
    expect(fitReply('two\n\nlines')).toBe('two lines');
  });
});

describe('x cursor', () => {
  it('uses a cursor only for the account that wrote it', () => {
    const state = { userId: '123', sinceId: '999' };

    expect(cursorFor(state, '123')).toBe('999');
    // Another account's cursor would silently hide every mention.
    expect(cursorFor(state, '456')).toBeUndefined();
  });
});
