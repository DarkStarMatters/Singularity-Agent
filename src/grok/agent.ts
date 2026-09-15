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

  constructor(
    private readonly client: GrokClient,
    private readonly options: AgentOptions,
  ) {
    this.memory = options.memory ?? new ConversationMemory();
    this.maxToolRounds = options.maxToolRounds ?? 4;
  }

  /**
   * A sibling agent on the same client with different options and its own
   * memory — used for one-off writing tasks, like composing a project update,
   * that must not inherit a conversation's history or its fallback behaviour.
   */
  variant(overrides: Partial<AgentOptions>): GrokAgent {
    return new GrokAgent(this.client, { ...this.options, memory: undefined, ...overrides });
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

    const working: ChatMessage[] = [
      { role: 'system', content: this.options.system },
      ...history,
      incoming,
    ];

    const toolRuns: ToolRun[] = [];
    const useTools = this.options.tools !== false;
    let rounds = 0;

    while (true) {
      const lastRound = rounds >= this.maxToolRounds;

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

      const text = assistant.content || (this.options.allowEmpty ? '' : EMPTY_FALLBACK);

      // Nothing said, and the caller asked for silence: do not remember the
      // turn either, or the next prompt inherits an empty assistant message.
      if (!text) return { text: '', toolRuns, rounds };

      // Only the conversation is remembered, not the tool traffic: replaying
      // tool calls would balloon every later prompt for no gain, since the
      // numbers are already stated in the answer.
      this.memory.append(conversationId, [incoming, { role: 'assistant', content: text }]);

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

/** Convenience for a surface that just wants a working agent. */
export function createAgent(
  client: GrokClient,
  platform: 'telegram' | 'x' | 'plain',
  overrides: Partial<AgentOptions> = {},
): GrokAgent {
  return new GrokAgent(client, { system: systemPromptFor(platform), ...overrides });
}
