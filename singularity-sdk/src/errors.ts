/**
 * Errors the SDK raises on its own behalf.
 *
 * Everything the agent core raises comes through untouched as a
 * `SingularityError` — wrapping those would only bury a hint somebody wrote
 * carefully. These are the failures that only exist once there is a client, a
 * signer and a cache in the picture.
 */

/** Codes this package raises. Stable; callers switch on them. */
export type SdkErrorCode =
  | 'NO_CHAIN'
  | 'NO_SIGNER'
  | 'SIGNER_WRONG_FAMILY'
  | 'SIGNER_CANNOT_BROADCAST'
  | 'SIGNER_CHAIN_MISMATCH'
  | 'SIGNER_ADDRESS_MISMATCH'
  | 'WATCH_ABORTED'
  | 'WATCH_FAILED'
  | 'TEMPLATE_NOT_FOUND'
  | 'TARGET_EXISTS';

export class SdkError extends Error {
  readonly code: SdkErrorCode;
  /** What to do about it. Never a restatement of the message. */
  readonly hint?: string;

  constructor(code: SdkErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'SdkError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }

  /** Shape a tool result or a log line can carry. */
  toJSON(): { code: SdkErrorCode; message: string; hint?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

export function isSdkError(err: unknown): err is SdkError {
  return err instanceof SdkError;
}
