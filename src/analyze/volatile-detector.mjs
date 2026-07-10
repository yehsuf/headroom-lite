/**
 * Detect volatile content patterns in the prompt-cache hot zone.
 *
 * Scans only the frozen prefix (messages[0..frozenCount]) and the system
 * prompt — the parts that form the cache key. Patterns that change per-request
 * in these zones silently destroy cache hit rates.
 *
 * Detected patterns:
 *   - ISO 8601 full datetime (e.g. "2024-01-15T10:30:00Z", "2024-01-15T10:30:00.000Z")
 *   - UUID v4 (e.g. "550e8400-e29b-41d4-a716-446655440000")
 *   - Fields with ID-like names containing short opaque values
 *     (names matching: id, *_id, *Id, request_id, trace_id, correlation_id,
 *      session_id, span_id, transaction_id — with values that are short strings
 *      that look like generated identifiers, NOT human-readable text)
 *
 * Returns up to MAX_WARNINGS warnings to avoid noise.
 */

export const MAX_WARNINGS = 5;

// ISO 8601 datetime — requires at least date+time (not just date "2024-01-15")
const ISO_DATETIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;

// UUID v4 — standard 8-4-4-4-12 hex format
const UUID_V4_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

// ID-like field names (exact or suffix match)
const ID_FIELD_NAMES = new Set(['id', 'request_id', 'trace_id', 'correlation_id',
  'session_id', 'span_id', 'transaction_id', 'requestId', 'traceId',
  'correlationId', 'sessionId', 'spanId', 'transactionId']);

// Minimal frozen-prefix computation — replaced when P0 merges.
// A message is frozen if it (or any of its content blocks) carries a
// cache_control marker. Returns the 1-based index of the last such message.
export function computeFrozenCount(messages) {
  let lastBreakpoint = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messageHasCacheControl(messages[i])) lastBreakpoint = i;
  }
  return lastBreakpoint + 1;
}

function messageHasCacheControl(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.cache_control) return true;
  const { content } = message;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.cache_control) return true;
    }
  }
  return false;
}

function scanText(text, location, warnings) {
  if (warnings.length >= MAX_WARNINGS) return;

  const isoMatch = ISO_DATETIME_RE.exec(text);
  if (isoMatch) {
    warnings.push({
      pattern: 'iso_datetime',
      location,
      sample: text.slice(isoMatch.index, isoMatch.index + 40),
    });
  }

  if (warnings.length >= MAX_WARNINGS) return;

  const uuidMatch = UUID_V4_RE.exec(text);
  if (uuidMatch) {
    warnings.push({
      pattern: 'uuid_v4',
      location,
      sample: text.slice(uuidMatch.index, uuidMatch.index + 40),
    });
  }
}

function scanObject(obj, location, warnings) {
  if (!obj || typeof obj !== 'object' || warnings.length >= MAX_WARNINGS) return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && warnings.length < MAX_WARNINGS; i++) {
      scanObject(obj[i], `${location}[${i}]`, warnings);
    }
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (warnings.length >= MAX_WARNINGS) break;
    if (ID_FIELD_NAMES.has(key)) {
      if (typeof value === 'string' && value.length > 0 && value.length < 64 && !value.includes(' ')) {
        warnings.push({ pattern: 'id_field', location: `${location}.${key}`, sample: value.slice(0, 40) });
      }
    } else if (value && typeof value === 'object') {
      scanObject(value, `${location}.${key}`, warnings);
    }
  }
}

function scanMessage(message, location, warnings) {
  if (!message || typeof message !== 'object' || warnings.length >= MAX_WARNINGS) return;

  const { content } = message;

  if (typeof content === 'string') {
    scanText(content, `${location}.content`, warnings);
  } else if (Array.isArray(content)) {
    for (let i = 0; i < content.length && warnings.length < MAX_WARNINGS; i++) {
      const block = content[i];
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        scanText(block.text, `${location}.content[${i}].text`, warnings);
      }
    }
  }

  scanObject(message, location, warnings);
}

export function detectVolatileContent({ messages = [], frozenCount = 0, system = null }) {
  const warnings = [];

  if (system) {
    scanText(String(system), 'system', warnings);
  }

  for (let i = 0; i < frozenCount && i < messages.length; i++) {
    scanMessage(messages[i], `messages[${i}]`, warnings);
    if (warnings.length >= MAX_WARNINGS) break;
  }

  return warnings;
}
