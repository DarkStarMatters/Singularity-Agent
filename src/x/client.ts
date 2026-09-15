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

const API_ROOT = 'https://api.x.com/2';
const TWEETS_ENDPOINT = `${API_ROOT}/tweets`;
const VERIFY_ENDPOINT = `${API_ROOT}/users/me`;

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
  /** The post this one answers, when it is a reply. */
  inReplyTo?: string;
}

/** One mention or reply, flattened into what the agent actually needs. */
export interface Mention {
  id: string;
  text: string;
  authorId: string;
  /** Resolved from the response's `includes`, when X sent it. */
  authorUsername?: string;
  /** Groups a whole reply thread; used as the conversation memory key. */
  conversationId?: string;
  /** The post this one replies to, when it is a reply rather than a mention. */
  repliedToId?: string;
  createdAt?: string;
  /** Author signals used by the spam filter; absent if X did not send them. */
  authorFollowers?: number;
  authorCreatedAt?: string;
}

export interface MentionPage {
  mentions: Mention[];
  /** Pass back as `sinceId` next poll. Absent when nothing new arrived. */
  newestId?: string;
}

export class XApiError extends SingularityError {
  constructor(status: number, detail: string) {
    super(
      'X_API_ERROR',
      `X API returned ${status}: ${detail}`,
      status === 401
        ? 'Check X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET, and that the app has Read and Write permission. Access tokens issued before Write was enabled stay read-only until regenerated.'
        : status === 403
          ? 'The app is read-only, or the post duplicates a recent one. Fixing the permissions takes TWO steps in the X developer portal, and the second is the one people miss: (1) the app → User authentication settings → App permissions → "Read and write"; (2) Keys and tokens → REGENERATE the Access Token and Secret. A token minted while the app was read-only stays read-only forever — changing the permission does not upgrade it. Then put the new X_ACCESS_TOKEN and X_ACCESS_SECRET in .env.'
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
   * Mentions and replies addressed to `userId`, newest-first from X.
   *
   * `sinceId` is what makes this safe to poll: X returns only what arrived
   * after that post, so a restart with a persisted id does not answer the same
   * mention twice. Without it, only the most recent few are fetched — enough to
   * establish a starting point without replying to a backlog.
   */
  async mentions(userId: string, sinceId?: string, maxResults = 20): Promise<MentionPage> {
    const url = new URL(`${API_ROOT}/users/${encodeURIComponent(userId)}/mentions`);
    url.searchParams.set('max_results', String(Math.min(Math.max(maxResults, 5), 100)));
    url.searchParams.set('tweet.fields', 'created_at,author_id,conversation_id,referenced_tweets');
    url.searchParams.set('expansions', 'author_id');
    // public_metrics and created_at feed the spam filter — a throwaway account
    // is the strongest single signal, and they cost nothing extra here.
    url.searchParams.set('user.fields', 'username,public_metrics,created_at');
    if (sinceId) url.searchParams.set('since_id', sinceId);

    const href = url.toString();
    const response = await fetch(href, {
      headers: { authorization: buildAuthHeader('GET', href, this.config) },
    });

    const body = (await response.json().catch(() => ({}))) as {
      data?: Array<{
        id: string;
        text: string;
        author_id?: string;
        conversation_id?: string;
        created_at?: string;
        referenced_tweets?: Array<{ type: string; id: string }>;
      }>;
      includes?: {
        users?: Array<{
          id: string;
          username: string;
          created_at?: string;
          public_metrics?: { followers_count?: number };
        }>;
      };
      meta?: { newest_id?: string; result_count?: number };
      detail?: string;
      title?: string;
    };

    if (!response.ok) {
      throw new XApiError(response.status, body.detail ?? body.title ?? 'no detail');
    }

    const authors = new Map((body.includes?.users ?? []).map((user) => [user.id, user] as const));

    const mentions: Mention[] = (body.data ?? []).map((tweet) => {
      const author = tweet.author_id ? authors.get(tweet.author_id) : undefined;
      const parent = tweet.referenced_tweets?.find((ref) => ref.type === 'replied_to');
      const followers = author?.public_metrics?.followers_count;

      return {
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.author_id ?? '',
        ...(author ? { authorUsername: author.username } : {}),
        ...(author?.created_at ? { authorCreatedAt: author.created_at } : {}),
        ...(typeof followers === 'number' ? { authorFollowers: followers } : {}),
        ...(tweet.conversation_id ? { conversationId: tweet.conversation_id } : {}),
        ...(tweet.created_at ? { createdAt: tweet.created_at } : {}),
        ...(parent ? { repliedToId: parent.id } : {}),
      };
    });

    return {
      mentions,
      ...(body.meta?.newest_id ? { newestId: body.meta.newest_id } : {}),
    };
  }

  /**
   * Replies to a post. Gated exactly as `post()` is — a reply is as public and
   * as permanent as a top-level post, and there is no reason to trust it more.
   */
  reply(
    text: string,
    inReplyToTweetId: string,
    options: { dryRun?: boolean } = {},
  ): Promise<PostResult> {
    return this.post(text, { ...options, inReplyTo: inReplyToTweetId });
  }

  /**
   * Publishes, or returns a draft when posting is disabled.
   *
   * Length is checked before the switch so a too-long draft is caught during a
   * dry run rather than at the moment someone enables publishing.
   */
  async post(
    text: string,
    options: { dryRun?: boolean; inReplyTo?: string } = {},
  ): Promise<PostResult> {
    const trimmed = text.trim();
    const threading = options.inReplyTo ? { inReplyTo: options.inReplyTo } : {};

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
      return { published: false, text: trimmed, reason: 'Dry run requested.', ...threading };
    }
    if (!this.config.postingEnabled) {
      return {
        published: false,
        text: trimmed,
        reason: 'Posting is disabled. Set X_POSTING_ENABLED=true in .env to publish for real.',
        ...threading,
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
      body: JSON.stringify({
        text: trimmed,
        ...(options.inReplyTo ? { reply: { in_reply_to_tweet_id: options.inReplyTo } } : {}),
      }),
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
      ...threading,
    };
  }
}
