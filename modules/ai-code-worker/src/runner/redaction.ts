import { sha256 } from "../manifest/normalize.js";

export interface RedactionResult {
  readonly text: string;
  readonly redacted: boolean;
  readonly sha256: string;
}

const secretPatterns: readonly RegExp[] = [
  /\\?["']?(?:api[_-]?key|token|secret|password)\\?["']?\s*[:=]\s*\\?["']?[\w.-]{8,}\\?["']?/gi,
  /sk-[A-Za-z0-9_-]{12,}/g
];

export function redactText(input: string): RedactionResult {
  let text = input;
  let redacted = false;

  for (const pattern of secretPatterns) {
    text = text.replace(pattern, () => {
      redacted = true;
      return "[REDACTED]";
    });
  }

  return {
    text,
    redacted,
    sha256: sha256(text)
  };
}

export const DEFAULT_MAXIMUM_REPORT_TEXT_LENGTH = 8_000;

export interface PreparedReportText {
  readonly text: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly sha256: string;
}

/**
 * Redacts secret-looking substrings, then caps the result to a bounded
 * length ("fragmente de eroare limitate ca mărime", IMPLEMENTATION-PLAN.md
 * §10.2) - for free-text fields going into persisted reports (BLOCKED.md,
 * repair evidence, finding evidence), not for byte-exact artifacts like
 * exported patches, where either transform would corrupt the artifact.
 */
export function prepareReportText(input: string, maximumLength: number = DEFAULT_MAXIMUM_REPORT_TEXT_LENGTH): PreparedReportText {
  const redactedResult = redactText(input);
  const truncated = redactedResult.text.length > maximumLength;
  const text = truncated
    ? `${redactedResult.text.slice(0, maximumLength)}\n[TRUNCATED: ${redactedResult.text.length - maximumLength} additional characters omitted]`
    : redactedResult.text;

  return {
    text,
    redacted: redactedResult.redacted,
    truncated,
    sha256: sha256(text)
  };
}
