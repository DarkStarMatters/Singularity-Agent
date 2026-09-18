/**
 * The conversational loop: message in, answer out, tools called along the way.
 *
 * Shared by Telegram and X so the two cannot develop different personalities or
 * different ideas about what the tools can do. The platform supplies the system
 * prompt and the memory key; everything else is identical.
 *
 * The loop is bounded twice over. `maxToolRounds` stops a model that keeps
 * calling tools instead of answering, and the final round is sent *without*
 * tools attached, which forces a text answer rather than returning nothing —
 * "the model ran out of rounds" is not something a user in a group chat can act
 * on.
 */
import { GrokClient, type ChatMessage } from './client.js';
import { runToolCall, toolSchemas, type ToolRun } from './tools.js';
import { ConversationMemory } from './memory.js';
import { systemPromptFor } from './persona.js';
import { RecentVoice, retryNote, varietyNote } from './variety.js';

export interface AgentOptions {
  system: string;
  /** Tool round trips allowed before a text answer is demanded. */
  maxToolRounds?: number;
  maxTokens?: number;
  temperature?: number;
  /** Set false for a surface where tool answers are not wanted. */
  tools?: boolean;
  /**
   * Return an empty string instead of a fallback when the model says nothing.
   *
   * A chat surface wants the fallback: a person waiting on a reply needs to be
   * told something went wrong. An autonomous poster wants the opposite — an
   * empty completion means "nothing to say", and publishing "I could not put an
   * answer together" to X would be worse than silence.
   */
  allowEmpty?: boolean;
  memory?: ConversationMemory;
  /**
   * Replies this agent has already sent, across every conversation.
   *
   * Conversation memory is per-thread, which is right for context and useless
   * for voice: two strangers asking the same question a week apart each get a
   * cold start, and the model reliably reaches for the same opening. This is
   * the thing that remembers what was said out loud, so the next reply can be
   * told not to say it again.
   *
   * Shared deliberately. One instance across Telegram and X means the agent
   * does not repeat on one surface what it just said on the other.
   */
  voice?: RecentVoice;
}

export interface AgentReply {
  text: string;
  toolRuns: ToolRun[];
  rounds: number;
}

/** Shown when the model returns neither text nor a tool call. */
const EMPTY_FALLBACK = 'I could not put an answer together for that. Try rephrasing it?';

export class GrokAgent {
  private readonly memory: ConversationMemory;
  private readonly maxToolRounds: number;
  private readonly voice: RecentVoice | undefined;

  constructor(
    private readonly client: GrokClient,
    private readonly options: AgentOptions,
  ) {
    this.memory = options.memory ?? new ConversationMemory();
    this.maxToolRounds = options.maxToolRounds ?? 4;
    this.voice = options.voice;
  }

  /**
   * A sibling agent on the same client with different options and its own
   * memory — used for one-off writing tasks, like composing a project update,
   * that must not inherit a conversation's history or its fallback behaviour.
   */
  variant(overrides: Partial<AgentOptions>): GrokAgent {
    // `voice` is dropped along with `memory`, and for the same reason. A
    // variant is a different job: the update composer already excludes its own
    // recent subjects and lists its own recent posts in its prompt, so feeding
    // it the reply history would have two anti-repetition systems arguing over
    // one draft.
    return new GrokAgent(this.client, {
      ...this.options,
      memory: undefined,
      voice: undefined,
      ...overrides,
    });
  }

  /** Exposed so a surface can offer a "forget this thread" command. */
  forget(conversationId: string): void {
    this.memory.clear(conversationId);
  }

  /**
   * Has this agent already spoken in this conversation?
   *
   * The X listener uses this to tell a genuine follow-up from a first contact.
   * "Is a reply" is not the same question: every reply to one of the agent's
   * posts is a reply, including the engagement bots'.
   */
  hasHistory(conversationId: string): boolean {
    return this.memory.get(conversationId).length > 0;
  }

  async respond(
    conversationId: string,
    userMessage: string,
    speaker?: string,
  ): Promise<AgentReply> {
    const history = this.memory.get(conversationId);

    // `name` is what lets the model tell two people apart in a group thread.
    const incoming: ChatMessage = {
      role: 'user',
      content: userMessage,
      ...(speaker ? { name: sanitizeName(speaker) } : {}),
    };

    // The voice note rides on the system message rather than the user turn, so
    // it shapes how the answer is written without being mistaken for part of
    // what was asked.
    const spoken = this.voice?.recent() ?? [];
    const system = spoken.length
      ? [this.options.system, ...varietyNote(spoken)].join('\n')
      : this.options.system;

    const working: ChatMessage[] = [
      { role: 'system', content: system },
      ...history,
      incoming,
    ];

    const toolRuns: ToolRun[] = [];
    const useTools = this.options.tools !== false;
    let rounds = 0;
    let retried = false;

    while (true) {
      // A rewrite for voice needs no tools: the numbers are already in the
      // transcript, and handing them back would invite a fresh round of calls
      // to reach the same figures.
      const lastRound = rounds >= this.maxToolRounds || retried;

      const assistant = await this.client.complete(working, {
        ...(this.options.temperature !== undefined
          ? { temperature: this.options.temperature }
          : {}),
        ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
        // Withholding the tools on the last round is what guarantees prose.
        ...(useTools && !lastRound ? { tools: toolSchemas() } : {}),
      });

      if (assistant.toolCalls.length && !lastRound) {
        rounds++;

        working.push({
          role: 'assistant',
          content: assistant.content,
          tool_calls: assistant.toolCalls,
        });

        // Sequential rather than parallel: these hit public RPC endpoints that
        // rate-limit, and a model usually asks for two or three at most.
        for (const call of assistant.toolCalls) {
          const run = await runToolCall(call);
          toolRuns.push(run);
          working.push({ role: 'tool', content: run.result, tool_call_id: call.id });
        }
        continue;
      }

      let text = assistant.content || (this.options.allowEmpty ? '' : EMPTY_FALLBACK);

      // An instruction not to repeat is a request; this is the part that
      // checks. One retry only: a second collision usually means the question
      // really was the same question, and at that point saying the same thing
      // is the correct answer rather than a failure of imagination.
      if (text && assistant.content && this.voice && !retried) {
        const collision = this.voice.collides(text);
        if (collision.repeats) {
          retried = true;
          working.push({ role: 'assistant', content: text });
          working.push({ role: 'user', content: retryNote(collision) });
          continue;
        }
      }

      // Nothing said, and the caller asked for silence: do not remember the
      // turn either, or the next prompt inherits an empty assistant message.
      if (!text) return { text: '', toolRuns, rounds };

      // Only the conversation is remembered, not the tool traffic: replaying
      // tool calls would balloon every later prompt for no gain, since the
      // numbers are already stated in the answer.
      this.memory.append(conversationId, [incoming, { role: 'assistant', content: text }]);

      // Remembered only once it is the answer, because a draft that was
      // rewritten was never said to anybody.
      if (assistant.content) this.voice?.remember(text);

      return { text, toolRuns, rounds };
    }
  }
}

/**
 * xAI accepts a narrow character set for `name`, and a Telegram display name
 * can be anything at all — emoji, spaces, right-to-left marks.
 */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned.replace(/^_+|_+$/g, '') || 'user';
}

/**
 * One voice memory for the whole process.
 *
 * Shared on purpose. Telegram and X are the same account answering the same
 * questions, and an agent that repeats on one surface what it said an hour ago
 * on the other is repeating itself as far as anyone reading both is concerned.
 * A caller that wants isolation — a test, mostly — passes its own.
 */
let processVoice: RecentVoice | undefined;

export function sharedVoice(): RecentVoice {
  processVoice ??= new RecentVoice();
  return processVoice;
}

/** Test seam: the shared voice outlives a single case otherwise. */
export function resetSharedVoice(): void {
  processVoice = undefined;
}

/** Convenience for a surface that just wants a working agent. */
export function createAgent(
  client: GrokClient,
  platform: 'telegram' | 'x' | 'plain',
  overrides: Partial<AgentOptions> = {},
): GrokAgent {
  // Conversation gets the shared voice and a little more heat than the 0.7
  // default. `plain` does not: it is the scripted surface, where a stable
  // answer is worth more than a fresh one.
  //
  // No sampling penalties. They were here for one commit and broke the bot:
  // grok-4 rejects frequency_penalty and presence_penalty with a 400, so every
  // post failed. Variety is handled in `variety.ts` instead, which works on any
  // model because it never leaves this process.
  const conversational = platform !== 'plain';

  return new GrokAgent(client, {
    system: systemPromptFor(platform),
    ...(conversational ? { voice: sharedVoice(), temperature: 0.85 } : {}),
    ...overrides,
  });
}
