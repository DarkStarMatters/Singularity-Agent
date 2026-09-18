/**
 * Ask the deployed burn endpoint whether it is alive, the way a wallet would.
 *
 * `api/burn` is the one thing here that cannot be proven by the test suite: it
 * is not a function this repo calls, it is a URL a wallet fetches, and every
 * interesting way for it to be broken lives in the deployment rather than in
 * the code. It shipped in a release that described it as working, and it had
 * answered 500 to every request it had ever received — the module failed to
 * compile under the config Vercel reads, which no local check consulted.
 *
 * So this exists to be run against the real URL after a deploy:
 *
 *   npm run smoke:burn
 *   npm run smoke:burn -- https://example.test/api/burn
 *
 * The POST case is the valuable one. It burns nothing and needs no funded
 * wallet: an account that holds none of the mint must come back as
 * NO_TOKEN_ACCOUNT, and getting that specific answer means the module loaded,
 * the cluster was reached, the mint's decimals and program were read, and the
 * associated token account was derived. A dead function cannot produce it.
 */

const DEFAULT_ENDPOINT = 'https://singularity-agent.cicada71.net/api/burn';
const DEFAULT_MINT = '5pTy48gtfzaR8NPUVZTbybVUGpQvFT4JsNHzwQE8pump';

/** The System Program: a valid pubkey that will never hold a token account. */
const EMPTY_ACCOUNT = '11111111111111111111111111111111';

const endpoint = process.argv[2] || process.env.SINGULARITY_PAY_ENDPOINT || DEFAULT_ENDPOINT;
const mint = process.env.SINGULARITY_SMOKE_MINT || DEFAULT_MINT;

const failures = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${name}`);
    return true;
  }
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  failures.push(name);
  return false;
}

function url(params) {
  const target = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

/** Body may be JSON or an HTML error page; the caller wants both possibilities. */
async function read(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

console.log(`\nBurn endpoint: ${endpoint}`);
console.log(`Mint:          ${mint}\n`);

// ── What the wallet asks first ──────────────────────────────────────────────
console.log('GET — what the wallet shows before it asks anyone to approve anything');
const get = await fetch(url({ mint, amount: '1' }));
const shown = await read(get);

check('responds 200', get.status === 200, `got ${get.status} ${shown.text.slice(0, 120)}`);
check('is JSON', shown.json !== undefined, shown.text.slice(0, 120));
check('names a label', typeof shown.json?.label === 'string' && shown.json.label.length > 0);
check('names an https icon', String(shown.json?.icon || '').startsWith('https://'), shown.json?.icon);

// The icon is the one element of the approval screen a wallet cannot vouch
// for if it comes from somewhere other than the endpoint it is talking to.
if (shown.json?.icon) {
  check(
    'serves the icon from the endpoint origin',
    new URL(shown.json.icon).origin === new URL(endpoint).origin,
    `${new URL(shown.json.icon).origin} is not ${new URL(endpoint).origin}`,
  );

  const icon = await fetch(shown.json.icon, { redirect: 'manual' });
  check('icon loads without a redirect', icon.status === 200, `got ${icon.status}`);
  check(
    'icon is an image',
    (icon.headers.get('content-type') || '').startsWith('image/'),
    icon.headers.get('content-type') || 'no content-type',
  );
}

// ── What the endpoint must refuse ───────────────────────────────────────────
console.log('\nRefusals — the endpoint serves a named set of mints, not any mint');
const bare = await fetch(endpoint);
check('400 with no parameters', bare.status === 400, `got ${bare.status}`);

const foreign = await fetch(url({ mint: 'So11111111111111111111111111111111111111112', amount: '1' }));
check('403 for a mint it does not serve', foreign.status === 403, `got ${foreign.status}`);

const nonsense = await fetch(url({ mint, amount: 'lots' }));
check('400 for an amount that is not one', nonsense.status === 400, `got ${nonsense.status}`);

// ── The whole pipeline, burning nothing ─────────────────────────────────────
console.log('\nPOST — builds a real burn, for an account that holds none of it');
const post = await fetch(url({ mint, amount: '1' }), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: EMPTY_ACCOUNT }),
});
const built = await read(post);

const reached =
  post.status === 400 && built.json?.error === 'NO_TOKEN_ACCOUNT';

check(
  'reaches the chain and derives the token account',
  reached,
  `expected 400 NO_TOKEN_ACCOUNT, got ${post.status} ${JSON.stringify(built.json ?? built.text.slice(0, 160))}`,
);

const missingAccount = await fetch(url({ mint, amount: '1' }), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
check('400 when the POST carries no account', missingAccount.status === 400, `got ${missingAccount.status}`);

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks failed:`);
  for (const name of failures) console.error(`  - ${name}`);
  console.error('\nThe endpoint is not serving burns. Nobody can tap the link.');
  process.exit(1);
}

console.log(`All ${checks} checks passed. A wallet can complete this flow.\n`);
