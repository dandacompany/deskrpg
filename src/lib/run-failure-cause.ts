/**
 * Reads why a Hermes run failed from its failure text — the part the user can act on.
 *
 * A run that fails after the gateway accepted it (`HermesError` code `run_failed`) only carries
 * the provider's own sentence. DMs and meetings both need to tell "sign in to the model provider
 * again" from "the account hit its limit" from "the model does not exist", so the rule lives
 * here once. The text itself never goes to the client; only the cause does.
 *
 * Pure and dependency-free — safe for the client bundle.
 */
export type RunFailureCause = "provider_auth" | "usage_limit" | "model_error";

/** The model provider's account/billing limit (checked first, as the meeting path always did). */
const USAGE_LIMIT = /\b429\b|usage limit|rate[ _-]?limit|quota|insufficient[ _]credits?/i;

/**
 * The provider rejected the sign-in. Hermes 0.21.2 says "rejected your sign-in … Sign in again:
 * `hermes -p <profile> auth add …`" and appends the provider's "HTTP 401: Incorrect API key".
 */
const PROVIDER_AUTH =
  /rejected your sign-in|sign in again|\bauth add\b|incorrect api key|invalid[ _]api[ _]key|\b401\b|token[ _](?:was |has been )?(?:expired|revoked|invalidated)|token_invalidated/i;

const MODEL_ERROR =
  /model[ _]not[ _]found|unknown model|invalid model|\bmodel\b[^.\n]{0,60}\b(?:does not exist|not found|is not supported|unsupported|unavailable)\b/i;

export function runFailureCause(detail: string | null | undefined): RunFailureCause | null {
  if (!detail) return null;
  if (USAGE_LIMIT.test(detail)) return "usage_limit";
  if (PROVIDER_AUTH.test(detail)) return "provider_auth";
  if (MODEL_ERROR.test(detail)) return "model_error";
  return null;
}
