/**
 * Pure terminal-text sanitization helpers.
 *
 * Strips ANSI/VT escape sequences (7-bit ESC and 8-bit C1 CSI/OSC/DCS/PM/APC),
 * C0/C1 control characters, and embedded line breaks, and bounds string length
 * before server-controlled strings reach Pi UI notifications or process.stderr.
 */

/** Default maximum character budget for a single log or notification string. */
export const DEFAULT_TERMINAL_TEXT_MAX_LENGTH = 500;

export interface SanitizeTerminalTextOptions {
  /** Maximum UTF-16 code units before truncating with `…` (default: 500). */
  maxLength?: number | undefined;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Strip ANSI CSI/OSC/DCS/PM/APC sequences (7-bit and 8-bit C1), single-char ESC
 * sequences, and C0/C1 control characters, collapse embedded CR/LF into spaces
 * so a single log or notification cannot inject fake lines, and bound length
 * with `…` without splitting a UTF-16 surrogate pair.
 */
export function sanitizeTerminalText(
  text: string,
  opts?: SanitizeTerminalTextOptions,
): string {
  const maxLength = opts?.maxLength ?? DEFAULT_TERMINAL_TEXT_MAX_LENGTH;
  if (maxLength <= 0) {
    return "";
  }

  const cleaned = text
    .replace(/\r$/, "")
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c|\x07|$)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\x1b|[\x00-\x1f\x7f-\x9f]/g, "");

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  if (maxLength === 1) {
    return "…";
  }

  let end = maxLength - 1;
  if (
    end > 0 &&
    isHighSurrogate(cleaned.charCodeAt(end - 1)) &&
    isLowSurrogate(cleaned.charCodeAt(end))
  ) {
    end -= 1;
  }

  return `${cleaned.slice(0, end)}…`;
}
