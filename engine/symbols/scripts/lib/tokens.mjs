/**
 * Shared token estimation — the single source of truth used by EVERY budget
 * enforcement point in the query layer (locate hit caps, impact budget,
 * slice refusal, brief card).
 *
 * Estimator: 1 token ≈ 4 characters, rounded up (ceil(chars / 4)).
 * Rationale: deterministic, locale-independent, platform-independent, and
 * conservative enough for ASCII-heavy code output. Never counts wall-clock,
 * locale-formatted numbers, or anything else that could vary between runs.
 */

export function estimateTokens(text) {
  const s = String(text ?? '');
  if (s.length === 0) return 0;
  return Math.ceil(s.length / 4);
}

/** Locate: hard per-hit ceiling (~40 tokens/hit target from the design doc). */
export const LOCATE_HIT_TOKENS = 40;
export const LOCATE_DEFAULT_LIMIT = 10;
export const LOCATE_MAX_LIMIT = 100;

/** Impact: hard output cap enforced while assembling the report. */
export const IMPACT_BUDGET_TOKENS = 600;
export const IMPACT_DEFAULT_DEPTH = 32;

/** Slice: default emission ceiling; over-budget asks are refused, not trimmed. */
export const SLICE_DEFAULT_MAX_TOKENS = 1200;

/** Brief: fixed orientation-card budget. */
export const BRIEF_BUDGET_TOKENS = 150;

/**
 * Check: hard output cap for the human drift report (design doc §7 allocates
 * ~200 tokens to the verify step of a typical modify task). The --json report
 * is machine-readable and intentionally NOT truncated by this budget.
 */
export const CHECK_BUDGET_TOKENS = 200;
/** Reserved headroom so the truncation hint always fits inside the cap. */
export const CHECK_HINT_RESERVE_TOKENS = 14;
export const CHECK_TRUNCATION_SUFFIX = 'more (use --json for the full report)';
