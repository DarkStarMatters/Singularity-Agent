/**
 * Grok (xAI) client.
 *
 * The xAI API is OpenAI-compatible, so this is a small POST against
 * /v1/chat/completions rather than an SDK. Kept deliberately narrow: the agent
 * needs one call shape (prompt in, text out) and nothing else.
 */
import { SingularityError } from '../core/errors.js';

const CHAT_ENDPOINT = 'https://api.x.ai/v1/chat/completions';

export interface GrokConfig {
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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

export class GrokClient {
  constructor(private readonly config: GrokConfig) {}

  async chat(
    messages: ChatMessage[],
    options: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

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
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      throw new GrokError(0, reason);
    } finally {
      clearTimeout(timer);
    }

    const body = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new GrokError(response.status, body.error?.message ?? `HTTP ${response.status}`);
    }

    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) throw new GrokError(response.status, 'response contained no message content');

    return content;
  }
}
