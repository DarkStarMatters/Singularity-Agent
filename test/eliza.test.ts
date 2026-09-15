import { describe, it, expect } from 'vitest';
import type { IAgentRuntime, Memory } from '@elizaos/core';
import { toPlainText } from '../src/eliza/plain.js';
import { parseQuery, parseTransfer, asChainId, tokenize } from '../src/eliza/parse.js';
import {
  balanceAction,
  portfolioAction,
  transactionAction,
  feesAction,
  blockAction,
  chainsAction,
  buildTransferAction,
  chainActions,
} from '../src/eliza/actions.js';
import {
  postToXAction,
  explicitPostText,
  cleanDraft,
  draftPrompt,
} from '../src/eliza/post-action.js';
import { postingStatusProvider, chainContextProvider } from '../src/eliza/providers.js';
import { toChatMessages } from '../src/eliza/grok-model.js';
import { settingsEnv } from '../src/eliza/settings.js';
import { singularityPlugin } from '../src/eliza/plugin.js';
import { DEFAULT_POST_LIMIT, loadXConfig } from '../src/x/client.js';

/** Every setting explicit, so nothing leaks in from the real environment. */
function stubRuntime(
  settings: Record<string, string> = {},
  useModel?: (type: string, params: { prompt: string }) => Promise<string>,
): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? '',
    useModel: useModel ?? (async () => ''),
  } as unknown as IAgentRuntime;
}

function msg(text: string): Memory {
  return { content: { text } } as Memory;
}

const X_CREDENTIALS = {
  X_API_KEY: 'key',
  X_API_SECRET: 'secret',
  X_ACCESS_TOKEN: 'token',
  X_ACCESS_SECRET: 'token-secret',
};

describe('toPlainText', () => {
  it('strips tags and decodes entities', () => {
    expect(toPlainText('<b>Base</b> — <code>0xabc</code>')).toBe('Base — 0xabc');
  });

  it('keeps the URL when unwrapping a link', () => {
    expect(toPlainText('<a href="https://basescan.org/tx/0x1">View</a>')).toBe(
      'View (https://basescan.org/tx/0x1)',
    );
  });

  it('does not repeat a URL that is its own label', () => {
    expect(toPlainText('<a href="https://x.com">https://x.com</a>')).toBe('https://x.com');
  });

  it('restores an escaped token symbol without letting it become a tag', () => {
    // A scam token literally named "<b>" arrives escaped from the formatter.
    expect(toPlainText('Symbol: &lt;b&gt;evil&lt;/b&gt;')).toBe('Symbol: <b>evil</b>');
  });

  it('leaves plain text alone', () => {
    expect(toPlainText('nothing to do here')).toBe('nothing to do here');
  });
});

describe('parseQuery', () => {
  it('finds an EVM address and a chain in a sentence', () => {
    const query = parseQuery('what does 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 hold on base?');
    expect(query.subject).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(query.chains).toEqual(['base']);
  });

  it('finds an ENS name with the question mark trimmed', () => {
    expect(parseQuery('balance of vitalik.eth?').subject).toBe('vitalik.eth');
  });

  it('separates a transaction hash from an address', () => {
    const hash = `0x${'a'.repeat(64)}`;
    const query = parseQuery(`did ${hash} land`);
    expect(query.txHash).toBe(hash);
    expect(query.subject).toBeUndefined();
  });

  it('collects several chains in the order they appear', () => {
    const query = parseQuery('vitalik.eth across base, arbitrum and optimism');
    expect(query.chains).toEqual(['base', 'arbitrum', 'optimism']);
  });

  it('resolves a chain alias to its canonical id', () => {
    expect(asChainId('eth')).toBe('ethereum');
  });

  it('does not read English filler as a chain', () => {
    expect(parseQuery('a balance for me on the chain').chains).toEqual([]);
  });

  it('keeps dots and dashes inside identifiers', () => {
    expect(tokenize('is vitalik.eth on arbitrum-nova?')).toContain('vitalik.eth');
  });
});

describe('parseTransfer', () => {
  it('reads amount, recipient, chain and token symbol', () => {
    const transfer = parseTransfer('send 25 USDC to vitalik.eth on base');
    expect(transfer.amount).toBe('25');
    expect(transfer.subject).toBe('vitalik.eth');
    expect(transfer.chains).toEqual(['base']);
    expect(transfer.token).toBe('USDC');
  });

  it('leaves the token unset for a native transfer', () => {
    expect(parseTransfer('send 0.1 to vitalik.eth on base').token).toBeUndefined();
  });

  it('does not mistake the chain name for the token', () => {
    expect(parseTransfer('send 1 to vitalik.eth on BASE').token).toBeUndefined();
  });
});

describe('action routing', () => {
  const validates = (action: (typeof chainActions)[number], text: string) =>
    action.validate(stubRuntime(), msg(text));

  it('routes a single-chain holdings question to BALANCE, not PORTFOLIO', async () => {
    const text = 'balance of vitalik.eth on base';
    await expect(validates(balanceAction, text)).resolves.toBe(true);
  });

  it('routes a multi-chain holdings question to PORTFOLIO, not BALANCE', async () => {
    const text = 'what does vitalik.eth hold across base and arbitrum';
    await expect(validates(portfolioAction, text)).resolves.toBe(true);
    await expect(validates(balanceAction, text)).resolves.toBe(false);
  });

  it('declines a balance question that names nothing to look up', async () => {
    await expect(validates(balanceAction, 'what is my balance')).resolves.toBe(false);
  });

  it('accepts a transaction question purely on the hash', async () => {
    await expect(validates(transactionAction, `status of 0x${'b'.repeat(64)}`)).resolves.toBe(true);
  });

  it('needs a chain before answering about fees', async () => {
    await expect(validates(feesAction, 'how is gas on ethereum')).resolves.toBe(true);
    await expect(validates(feesAction, 'how is gas today')).resolves.toBe(false);
  });

  it('does not fire FEES on a word that merely contains one', async () => {
    await expect(validates(feesAction, 'is ethereum coffees good')).resolves.toBe(false);
  });

  it('needs a chain before fetching a block', async () => {
    await expect(validates(blockAction, 'latest block on solana')).resolves.toBe(true);
    await expect(validates(blockAction, 'latest block')).resolves.toBe(false);
  });

  it('answers a bare capability question with CHAINS', async () => {
    await expect(validates(chainsAction, 'which chains do you support?')).resolves.toBe(true);
  });

  it('does not answer CHAINS when an address makes it a lookup', async () => {
    await expect(validates(chainsAction, 'which chains is vitalik.eth on?')).resolves.toBe(false);
  });

  it('requires a chain, a recipient and an amount before building a transfer', async () => {
    await expect(
      validates(buildTransferAction, 'send 0.1 ETH to vitalik.eth on base'),
    ).resolves.toBe(true);
    await expect(validates(buildTransferAction, 'send some ETH to vitalik.eth')).resolves.toBe(
      false,
    );
  });

  it('gives every action a distinct name', () => {
    const names = [...chainActions, postToXAction].map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('post text extraction', () => {
  it('prefers text the user quoted verbatim', () => {
    expect(explicitPostText('tweet this: "chain-agnostic beats maximalist"')).toBe(
      'chain-agnostic beats maximalist',
    );
  });

  it('takes everything after a post: marker', () => {
    expect(explicitPostText('post: gas is cheap today')).toBe('gas is cheap today');
  });

  it('returns null when the user only described what they wanted', () => {
    expect(explicitPostText('post something about base fees')).toBeNull();
  });

  it('unwraps a model draft that came back quoted', () => {
    expect(cleanDraft('"Base gas is under a cent."')).toBe('Base gas is under a cent.');
  });

  it('drops a preamble line', () => {
    expect(cleanDraft("Here's your post:\n\nBase gas is under a cent.")).toBe(
      'Base gas is under a cent.',
    );
  });

  it('states the character limit as a number the model can count to', () => {
    expect(draftPrompt('anything')).toContain(String(DEFAULT_POST_LIMIT));
  });
});

describe('POST_TO_X', () => {
  it('stays invisible to the agent when X is not configured', async () => {
    await expect(postToXAction.validate(stubRuntime(), msg('post about base'))).resolves.toBe(
      false,
    );
  });

  it('offers itself once credentials exist and the user asked to post', async () => {
    const runtime = stubRuntime(X_CREDENTIALS);
    await expect(postToXAction.validate(runtime, msg('post about base'))).resolves.toBe(true);
    await expect(postToXAction.validate(runtime, msg('what is gas on base'))).resolves.toBe(false);
  });

  it('drafts rather than publishes while the switch is off', async () => {
    const runtime = stubRuntime(X_CREDENTIALS);
    const result = await postToXAction.handler(runtime, msg('post: gas is cheap'));

    expect(result).toBeTruthy();
    // A draft is the designed outcome, so it is a success, not an error.
    expect(result!.success).toBe(true);
    expect(result!.text).toContain('draft');
    expect((result!.data as { post: { published: boolean } }).post.published).toBe(false);
  });

  it('still drafts on an explicit dry run with posting enabled', async () => {
    const runtime = stubRuntime({ ...X_CREDENTIALS, X_POSTING_ENABLED: 'true' });
    const result = await postToXAction.handler(runtime, msg('post: gas is cheap'), undefined, {
      dryRun: true,
    });

    expect((result!.data as { post: { published: boolean } }).post.published).toBe(false);
  });

  it('never treats a truthy-looking value as permission to publish', async () => {
    // Deliberately no "TRUE" case here: that one would really try to publish.
    for (const value of ['yes', '1', 'on', 'enabled', 'false', '']) {
      const runtime = stubRuntime({ ...X_CREDENTIALS, X_POSTING_ENABLED: value });
      const result = await postToXAction.handler(runtime, msg('post: gas is cheap'));

      expect((result!.data as { post: { published: boolean } }).post.published).toBe(false);
    }
  });

  it('accepts "true" in any casing, checked without going near the network', () => {
    for (const value of ['true', 'TRUE', ' True ']) {
      expect(loadXConfig({ ...X_CREDENTIALS, X_POSTING_ENABLED: value })?.postingEnabled).toBe(
        true,
      );
    }
  });

  it('posts the user text verbatim without asking a model', async () => {
    let modelCalled = false;
    const runtime = stubRuntime(X_CREDENTIALS, async () => {
      modelCalled = true;
      return 'something else entirely';
    });

    const result = await postToXAction.handler(runtime, msg('post: exactly this'));

    expect(modelCalled).toBe(false);
    expect(result!.text).toContain('exactly this');
  });

  it('drafts through the model when the user only described the post', async () => {
    const runtime = stubRuntime(X_CREDENTIALS, async () => '"Base fees are under a cent."');
    const result = await postToXAction.handler(runtime, msg('post something about base fees'));

    expect(result!.text).toContain('Base fees are under a cent.');
    expect(result!.text).not.toContain('"Base fees');
  });

  it('reports an over-length draft instead of publishing a truncated one', async () => {
    const runtime = stubRuntime(
      { ...X_CREDENTIALS, X_POSTING_ENABLED: 'true' },
      async () => 'x'.repeat(DEFAULT_POST_LIMIT + 1),
    );
    const result = await postToXAction.handler(runtime, msg('post about base'));

    expect(result!.success).toBe(false);
    expect(result!.text).toContain(String(DEFAULT_POST_LIMIT));
  });

  it('passes the callback the same text it returns', async () => {
    const runtime = stubRuntime(X_CREDENTIALS);
    const seen: string[] = [];

    const result = await postToXAction.handler(
      runtime,
      msg('post: gas is cheap'),
      undefined,
      undefined,
      async (content) => {
        seen.push(content.text ?? '');
        return [];
      },
    );

    expect(seen).toEqual([result!.text]);
  });
});

describe('providers', () => {
  const state = {} as never;

  it('tells the agent posting is disabled so it cannot claim otherwise', async () => {
    const result = await postingStatusProvider.get(stubRuntime(X_CREDENTIALS), msg(''), state);
    expect(result.text).toContain('DISABLED');
    expect(result.values?.xPostingEnabled).toBe(false);
  });

  it('warns that posting is live when it is', async () => {
    const runtime = stubRuntime({ ...X_CREDENTIALS, X_POSTING_ENABLED: 'true' });
    const result = await postingStatusProvider.get(runtime, msg(''), state);

    expect(result.text).toContain('LIVE');
    expect(result.values?.xPostingEnabled).toBe(true);
  });

  it('says X is unavailable rather than offering it', async () => {
    const result = await postingStatusProvider.get(stubRuntime(), msg(''), state);
    expect(result.text).toContain('not configured');
    expect(result.values?.xConfigured).toBe(false);
  });

  it('lists real chain ids, grouped by family', async () => {
    const result = await chainContextProvider.get(stubRuntime(), msg(''), state);

    expect(result.text).toContain('ethereum');
    expect(result.text).toContain('solana');
    expect(result.text).toContain('holds no private keys');
    expect(result.values?.chainCount).toBeGreaterThan(0);
  });
});

describe('settings bridge', () => {
  it('prefers a runtime setting over the process environment', () => {
    const env = settingsEnv(stubRuntime({ XAI_MODEL: 'grok-4-fast' }));
    expect(env.XAI_MODEL).toBe('grok-4-fast');
  });

  it('stringifies a boolean stored as a boolean', () => {
    const runtime = { getSetting: () => true } as unknown as IAgentRuntime;
    expect(settingsEnv(runtime).X_POSTING_ENABLED).toBe('true');
  });
});

describe('grok model handlers', () => {
  it('sends the flattened prompt as a single user turn', () => {
    expect(toChatMessages({ prompt: 'hello' })).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('registers both text sizes so useModel always has a handler', () => {
    expect(Object.keys(singularityPlugin.models ?? {})).toEqual(['TEXT_SMALL', 'TEXT_LARGE']);
  });
});

describe('plugin', () => {
  it('exposes every action, including the two gated ones', () => {
    // The chain lookups, plus POST_TO_X and POST_PROJECT_UPDATE.
    expect(singularityPlugin.actions).toHaveLength(chainActions.length + 2);

    const names = singularityPlugin.actions?.map((a) => a.name);
    expect(names).toContain('POST_TO_X');
    expect(names).toContain('POST_PROJECT_UPDATE');
  });

  it('gives every action a description the model can choose from', () => {
    for (const action of singularityPlugin.actions ?? []) {
      expect(action.description.length).toBeGreaterThan(40);
      expect(action.examples?.length).toBeGreaterThan(0);
    }
  });

  it('registers both providers', () => {
    expect(singularityPlugin.providers?.map((p) => p.name)).toEqual([
      'SINGULARITY_CHAINS',
      'X_POSTING_STATUS',
    ]);
  });
});
