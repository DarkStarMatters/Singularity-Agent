/**
 * OAuth 2.0 user-context tokens for X.
 *
 * The OAuth 1.0a path signs every request; this one carries a bearer token,
 * which is simpler but adds a problem 1.0a does not have: the token expires,
 * and refreshing it **rotates the refresh token too**. X invalidates the old
 * refresh token the moment it is used, so a refresh whose result is not
 * persisted locks the agent out permanently — the copy in `.env` is now dead
 * and the live one is only in memory.
 *
 * So refreshed tokens are written to disk immediately, and the stored pair
 * always wins over the one in the environment. The values in `.env` are a seed
 * for the first run, not the source of truth afterwards.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { SingularityError } from '../core/errors.js';

const TOKEN_ENDPOINT = 'https://api.x.com/2/oauth2/token';

export interface OAuth2Config {
  clientId: string;
  /** Absent for a public (PKCE) client; present for a confidential one. */
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** When the access token was last refreshed, for diagnosis. */
  refreshedAt?: string;
}

export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SINGULARITY_X_TOKENS || join(homedir(), '.singularity', 'x-tokens.json');
}

export function loadStoredTokens(path = tokenPath()): StoredTokens | null {
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredTokens;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;

    return {
      accessToken: parsed.accessToken,
      ...(typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {}),
    };
  } catch {
    return null;
  }
}

/** Written atomically: a truncated token file would lock the agent out. */
export function saveTokens(tokens: StoredTokens, path = tokenPath()): void {
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

  const temporary = `${path}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({ ...tokens, refreshedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  renameSync(temporary, path);
}

/**
 * Reads OAuth 2.0 config, preferring tokens already refreshed on disk.
 *
 * Returns null when there is no client id or no access token, so the caller
 * falls back to OAuth 1.0a.
 */
export function loadOAuth2Config(
  env: NodeJS.ProcessEnv = process.env,
  stored = loadStoredTokens(tokenPath(env)),
): OAuth2Config | null {
  const clientId = env.X_CLIENT_ID?.trim();
  const accessToken = stored?.accessToken ?? env.X_OAUTH2_ACCESS_TOKEN?.trim();

  if (!clientId || !accessToken) return null;

  const refreshToken = stored?.refreshToken ?? env.X_OAUTH2_REFRESH_TOKEN?.trim();
  const clientSecret = env.X_CLIENT_SECRET?.trim();

  return {
    clientId,
    accessToken,
    ...(clientSecret ? { clientSecret } : {}),
    ...(refreshToken ? { refreshToken } : {}),
  };
}

/**
 * Holds the live token and knows how to renew it.
 *
 * Deliberately mutable: the whole point is that the token in hand changes
 * during the process's life, and every caller must see the new one.
 */
export class OAuth2Tokens {
  private accessToken: string;
  private refreshToken: string | undefined;

  constructor(
    private readonly config: OAuth2Config,
    private readonly path = tokenPath(),
  ) {
    this.accessToken = config.accessToken;
    this.refreshToken = config.refreshToken;
  }

  header(): string {
    return `Bearer ${this.accessToken}`;
  }

  get canRefresh(): boolean {
    return Boolean(this.refreshToken);
  }

  /**
   * Exchanges the refresh token for a new pair, persisting both.
   *
   * Returns false rather than throwing when there is nothing to refresh with,
   * so a caller can fall back to reporting the original 401.
   */
  async refresh(): Promise<boolean> {
    if (!this.refreshToken) return false;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.config.clientId,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };

    // A confidential client authenticates with HTTP Basic; a public one sends
    // client_id in the body alone, which is already there.
    if (this.config.clientSecret) {
      const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
        'base64',
      );
      headers.authorization = `Basic ${basic}`;
    }

    const response = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers, body });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      error_description?: string;
      error?: string;
    };

    if (!response.ok || !payload.access_token) {
      throw new SingularityError(
        'X_REFRESH_FAILED',
        `Could not refresh the X token: ${payload.error_description ?? payload.error ?? response.status}`,
        'Refresh tokens are single-use and expire. Re-run the OAuth 2.0 authorization to get a fresh pair, then put them in X_OAUTH2_ACCESS_TOKEN and X_OAUTH2_REFRESH_TOKEN.',
      );
    }

    this.accessToken = payload.access_token;
    // X rotates the refresh token on every use; keeping the old one would fail
    // the next refresh.
    if (payload.refresh_token) this.refreshToken = payload.refresh_token;

    saveTokens(
      {
        accessToken: this.accessToken,
        ...(this.refreshToken ? { refreshToken: this.refreshToken } : {}),
      },
      this.path,
    );

    return true;
  }
}
