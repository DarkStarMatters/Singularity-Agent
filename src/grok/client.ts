/**
 * Grok (xAI) client.
 *
 * The xAI API is OpenAI-compatible, so this is a POST against
 * /v1/chat/completions rather than an SDK.
 *
 * Two call shapes are exposed. `chat()` is prompt-in/text-out and is what the
 * elizaOS model handlers use. `complete()` returns the whole assistant message,
 * including any tool calls, and is what the conversational agent loop in
 * `agent.ts` drives — it has to see the tool calls to answer them.
 */
import { SingularityError } from '../core/errors.js';

const CHAT_ENDPOINT = 'https://api.x.ai/v1/chat/completions';

export interface GrokConfig {
  apiKey: string;
  model: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on an assistant turn that wants tools run. */
  tool_calls?: ToolCall[];
  /** Required on a `tool` turn: which call this is the result of. */
  tool_call_id?: string;
  /** Distinguishes speakers in a group conversation. */
  name?: string;
}

/** A function the model may call, in OpenAI/xAI function-calling form. */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface AssistantMessage {
  content: string;
  toolCalls: ToolCall[];
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  tools?: ToolSchema[];
}

/** Returns null when no key is configured, so Grok stays optional. */
export function loadGrokConfig(env: NodeJS.ProcessEnv = process.env): GrokConfig | null {
  const apiKey = env.XAI_API_KEY?.trim();
  if (!apiKey) return null;

  return { apiKey, model: env.XAI_MODEL?.trim() || 'grok-4' };
}

export class GrokError extends SingularityError {
  constructor(status: number, detail: string) {
    super(
      'GROK_API_ERROR',
      `xAI API returned ${status}: ${detail}`,
      status === 401
        ? 'Check XAI_API_KEY. Keys come from console.x.ai and start with "xai-" — an X/Twitter API key will not work here.'
        : status === 404
          ? 'Check XAI_MODEL names a model your account can reach.'
          : status === 429
            ? 'Rate limited or out of credit on the xAI account.'
            : undefined,
    );
  }
}

interface ChatResponseBody {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  /** xAI sends a bare string here; OpenAI sends an object. Both are seen. */
  error?: string | { message?: string };
  code?: string;
}

/**
 * The API's own words, rather than its status code.
 *
 * This read `body.error?.message` and nothing else, which is correct for
 * OpenAI's shape and wrong for xAI's: it answers `{"code": "invalid-argument",
 * "error": "Model grok-4 does not support parameter presencePenalty."}`, where
 * `error` is a string with no `message` on it. So the sentence naming the exact
 * broken parameter was dropped and every caller logged "HTTP 400" instead —
 * a bot that had stopped posting, and a log that would not say why.
 */
export function describeError(body: ChatResponseBody, status: number): string {
  const detail = typeof body.error === 'string' ? body.error : body.error?.message;
  if (!detail) return `HTTP ${status}`;

  return body.code ? `${detail} (${body.code})` : detail;
}

export class GrokClient {
  constructor(private readonly config: GrokConfig) {}

  /** Text in, text out. Throws if the model answered with tool calls only. */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const message = await this.complete(messages, options);

    if (!message.content) {
      throw new GrokError(200, 'response contained no message content');
    }
    return message.content;
  }

  /**
   * One round trip. Returns whatever the model said, which may be text, tool
   * calls, or both — the caller decides what to do next.
   */
  async complete(messages: ChatMessage[], options: ChatOptions = {}): Promise<AssistantMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);

    let response: Response;
    try {
      response = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 512,
          // No frequency_penalty or presence_penalty here, and this is not an
          // oversight. xAI rejects both outright on grok-4 — "Model grok-4 does
          // not support parameter presencePenalty", HTTP 400 — so sending them
          // does not make the agent repeat itself less, it stops it answering
          // at all. Repetition is handled in `variety.ts`, above the API.
          ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      throw new GrokError(0, reason);
    } finally {
      clearTimeout(timer);
    }

    const body = (await response.json().catch(() => ({}))) as ChatResponseBody;

    if (!response.ok) {
      throw new GrokError(response.status, describeError(body, response.status));
    }

    const message = body.choices?.[0]?.message;
    if (!message) throw new GrokError(response.status, 'response contained no choices');

    return {
      content: message.content?.trim() ?? '',
      toolCalls: message.tool_calls ?? [],
    };
  }
}
