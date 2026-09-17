/**
 * The Solana Pay transaction request endpoint.
 *
 * Thin on purpose: everything worth testing lives in `src/pay/transaction-
 * request.ts`, and what remains here is the shape of an HTTP exchange —
 * methods, CORS, and turning a `SingularityError` into a status code. A wallet
 * is the client, so the error body matters less than the status, but a human
 * will eventually open this URL in a browser and should find a sentence rather
 * than a stack trace.
 *
 * Wallets call this cross-origin from inside their own app, so the permissive
 * CORS headers are required rather than careless. There is nothing to protect
 * here: every input arrives in the URL, the response is a transaction nobody has
 * signed, and the thing that decides whether anything happens is a human looking
 * at an approval screen.
 */
import {
  buildBurnRequest,
  describeBurnRequest,
  parseBurnRequest,
} from '../src/pay/transaction-request.js';
import { SingularityError } from '../src/core/errors.js';

interface Request {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface Response {
  status(code: number): Response;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(): void;
}

function cors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Encoding, Accept-Encoding');
  // A burn link is built for one moment: it names an amount and carries a
  // claim, and the transaction inside holds a blockhash good for seconds.
  res.setHeader('Cache-Control', 'no-store');
}

/** Query values arrive as string | string[]; the first one is the one meant. */
function single(query: Request['query']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function fail(res: Response, err: unknown): void {
  if (err instanceof SingularityError) {
    const status = err.code === 'MINT_NOT_ALLOWED' ? 403 : 400;
    res.status(status).json({ error: err.code, message: err.message, hint: err.hint });
    return;
  }

  res.status(500).json({
    error: 'UNEXPECTED',
    message: err instanceof Error ? err.message : String(err),
  });
}

export default async function handler(req: Request, res: Response): Promise<void> {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const params = parseBurnRequest(single(req.query));

    if (req.method === 'GET') {
      res.status(200).json(describeBurnRequest(params));
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' });
      return;
    }

    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as
      | { account?: unknown }
      | undefined;
    const account = typeof body?.account === 'string' ? body.account : undefined;

    if (!account) {
      res.status(400).json({
        error: 'NO_ACCOUNT',
        message: 'A transaction request POST carries the account that will sign.',
      });
      return;
    }

    res.status(200).json(await buildBurnRequest(account, params));
  } catch (err) {
    fail(res, err);
  }
}
