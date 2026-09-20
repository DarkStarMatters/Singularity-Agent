/**
 * The Solana Pay transaction request endpoint for payments.
 *
 * Thin on purpose, exactly as `burn.ts` is: everything worth testing lives in
 * `src/pay/payment-request.ts`, and what remains here is the shape of an HTTP
 * exchange — methods, CORS, and turning a `SingularityError` into a status
 * code. A wallet is the client, so the status carries most of the meaning, but
 * a human will eventually open this URL in a browser and should find a sentence
 * rather than a stack trace.
 *
 * Wallets call this cross-origin from inside their own app, so the permissive
 * CORS headers are required rather than careless. There is nothing to protect:
 * every input arrives in the URL, the response is a transaction nobody has
 * signed, and the thing that decides whether anything happens is a human
 * looking at an approval screen.
 *
 * **This will not build a payment until `SINGULARITY_PAY_RECIPIENTS` is set on
 * the deployment.** That is the whole safety property. An endpoint that builds
 * a payment to whatever address it is handed is a phishing primitive wearing
 * this domain, and the better this domain is trusted the better it works.
 */
import {
  buildPaymentRequest,
  describePaymentRequest,
  parsePaymentRequest,
} from '../src/pay/payment-request.js';
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
  // A payment link is built for one moment: it names an amount, and the
  // transaction inside holds a blockhash good for about a minute.
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
    // A refused recipient is a policy decision, not a malformed request, and a
    // 403 says so to anyone reading logs later.
    const status =
      err.code === 'RECIPIENT_NOT_ALLOWED' || err.code === 'NO_PAY_RECIPIENTS' ? 403 : 400;
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
    const params = parsePaymentRequest(single(req.query));

    if (req.method === 'GET') {
      res.status(200).json(describePaymentRequest(params));
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

    res.status(200).json(await buildPaymentRequest(account, params));
  } catch (err) {
    fail(res, err);
  }
}
