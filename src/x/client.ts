/**
 * Minimal X API v2 client — the write path.
 *
 * Publishing is public and effectively irreversible (a deleted post can already
 * have been seen, screenshotted, and indexed), so this module is built so that
 * publishing is never the default:
 *
 *   - `X_POSTING_ENABLED` must be exactly "true" or `post()` returns a draft.
 *   - `dryRun` can force a draft regardless of configuration.
 *
 * The caller is still expected to get human sign-off before flipping either.
 */
import { buildAuthHeader, type OAuthCredentials } from './oauth.js';
import { SingularityError } from '../core/errors.js';

const TWEETS_ENDPOINT = 'https://api.x.com/2/tweets';
const VERIFY_ENDPOINT = 'https://api.x.com/2/users/me';

/** The standard limit. Premium accounts allow more, but assume the floor. */
export const DEFAULT_POST_LIMIT = 280;

export interface XConfig extends OAuthCredentials {
  postingEnabled: boolean;
}

export interface PostResult {
  /** False when this was a draft — nothing left the process. */
  published: boolean;
  text: string;
  id?: string;
  url?: string;
  /** Why it was not published, when it was not. */
  reason?: string;
}

export class XApiError extends SingularityError {
  constructor(status: number, detail: string) {
    super(
      'X_API_ERROR',
      `X API returned ${status}: ${detail}`,
      status === 401
        ? 'Check X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET, and that the app has Read and Write permission. Access tokens issued before Write was enabled stay read-only until regenerated.'
        : status === 403
          ? 'The app may lack Write permission, or the post duplicates a recent one.'
          : status === 429
            ? 'Rate limited. The free tier allows very few posts per day.'
            : undefined,
    );
  }
}

/**
 * Reads X config from the environment. Returns null when credentials are absent,
 * so the Telegram bot can run perfectly well without X configured.
 */
export function loadXConfig(env: NodeJS.ProcessEnv = process.env): XConfig | null {
  const apiKey = env.X_API_KEY?.trim();
  const apiSecret = env.X_API_SECRET?.trim();
  const accessToken = env.X_ACCESS_TOKEN?.trim();
  const accessSecret = env.X_ACCESS_SECRET?.trim();

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;

  return {
    apiKey,
    apiSecret,
    accessToken,
    accessSecret,
    // Anything other than exactly "true" is off. No truthy-string guessing on a
    // switch whose failure mode is publishing by accident.
    postingEnabled: env.X_POSTING_ENABLED?.trim().toLowerCase() === 'true',
  };
}

export class XClient {
  constructor(private readonly config: XConfig) {}

  /** Confirms the credentials work and returns the acting account. */
  async verify(): Promise<{ id: string; username: string; name: string }> {
    const response = await fetch(VERIFY_ENDPOINT, {
      headers: { authorization: buildAuthHeader('GET', VERIFY_ENDPOINT, this.config) },
    });

    const body = (await response.json().catch(() => ({}))) as {
      data?: { id: string; username: string; name: string };
      detail?: string;
      title?: string;
    };

    if (!response.ok || !body.data) {
      throw new XApiError(response.status, body.detail ?? body.title ?? 'no detail');
    }
    return body.data;
  }

  /**
   * Publishes, or returns a draft when posting is disabled.
   *
   * Length is checked before the switch so a too-long draft is caught during a
   * dry run rather than at the moment someone enables publishing.
   */
  async post(text: string, options: { dryRun?: boolean } = {}): Promise<PostResult> {
    const trimmed = text.trim();

    if (!trimmed) {
      throw new SingularityError('EMPTY_POST', 'Refusing to post an empty message.');
    }
    if (trimmed.length > DEFAULT_POST_LIMIT) {
      throw new SingularityError(
        'POST_TOO_LONG',
        `Post is ${trimmed.length} characters; the limit is ${DEFAULT_POST_LIMIT}.`,
        'Shorten it, or split it into a thread.',
      );
    }

    if (options.dryRun) {
      return { published: false, text: trimmed, reason: 'Dry run requested.' };
    }
    if (!this.config.postingEnabled) {
      return {
        published: false,
        text: trimmed,
        reason: 'Posting is disabled. Set X_POSTING_ENABLED=true in .env to publish for real.',
      };
    }

    // JSON bodies are not part of the OAuth signature base string, so no body
    // params are passed here — see buildAuthHeader.
    const response = await fetch(TWEETS_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: buildAuthHeader('POST', TWEETS_ENDPOINT, this.config),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: trimmed }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      data?: { id: string; text: string };
      detail?: string;
      title?: string;
    };

    if (!response.ok || !body.data) {
      throw new XApiError(response.status, body.detail ?? body.title ?? 'no detail');
    }

    return {
      published: true,
      text: body.data.text,
      id: body.data.id,
      url: `https://x.com/i/web/status/${body.data.id}`,
    };
  }
}
