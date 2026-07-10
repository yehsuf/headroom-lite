import { createHash } from 'node:crypto';
import { computeFrozenCount } from '../compress/frozen-prefix.mjs';

export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1_000; // 1 hour
export const DEFAULT_MAX_SESSIONS = 10_000; // hard cap to prevent unbounded Map growth
export const MAX_SESSION_ID_LENGTH = 256;

export class DriftDetector {
  constructor({ ttlMs = DEFAULT_SESSION_TTL_MS, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
    this._ttlMs = ttlMs;
    this._maxSessions = maxSessions;
    this._sessions = new Map(); // Map<string, {hash: string, updatedAt: number}>
  }

  /**
   * Compute a stable SHA-256 fingerprint of the cache hot zone.
   * Only covers parts that should stay constant across requests for a session:
   *   - system prompt (normalized to string)
   *   - tool names (order-independent: sorted alphabetically)
   *   - frozen prefix messages (those carrying cache_control markers, per P0)
   *     Falls back to first 3 messages when no markers are present.
   */
  computeHash({ system, tools, messages }) {
    const msgs = Array.isArray(messages) ? messages : [];
    // Use the actual frozen prefix (cache_control markers) as the stable zone.
    // Fall back to the first 3 messages if no markers are present.
    const frozenCount = computeFrozenCount(msgs);
    const stableCount = frozenCount > 0 ? frozenCount : Math.min(3, msgs.length);

    const canonical = {
      system: system != null ? String(system) : null,
      // Only tool names — schemas may be normalized differently across callers
      tools: (Array.isArray(tools) ? tools : [])
        .map((t) => t?.name ?? t?.function?.name ?? '')
        .sort()
        .filter(Boolean),
      // Hash the frozen prefix (stable zone), not an arbitrary fixed window
      frozen: msgs.slice(0, stableCount).map((m) => ({
        role: m?.role ?? '',
        // Text content only — tool calls and images are handled separately
        text: typeof m?.content === 'string'
          ? m.content
          : (Array.isArray(m?.content) ? m.content : [])
              .filter((b) => b?.type === 'text')
              .map((b) => b.text ?? '')
              .join(''),
      })),
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  /**
   * Check a session for prefix drift.
   * @param {string} sessionId - Must be a non-empty string, max MAX_SESSION_ID_LENGTH chars
   * @param {{ system?, tools?, messages? }} body
   * @returns {{ status: 'first'|'stable'|'drifted', curr_hash: string, prev_hash?: string }}
   */
  check(sessionId, body) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 ||
        sessionId.length > MAX_SESSION_ID_LENGTH) {
      throw new Error(`session_id must be a non-empty string ≤${MAX_SESSION_ID_LENGTH} chars`);
    }

    const now = Date.now();
    this._evict(now);

    // Enforce hard session cap: evict oldest entry when at limit and this is a new session
    if (!this._sessions.has(sessionId) && this._sessions.size >= this._maxSessions) {
      // Evict the single oldest entry (by updatedAt) to stay within the cap
      let oldestId = null;
      let oldestTime = Infinity;
      for (const [id, entry] of this._sessions) {
        if (entry.updatedAt < oldestTime) { oldestTime = entry.updatedAt; oldestId = id; }
      }
      if (oldestId !== null) this._sessions.delete(oldestId);
    }

    const currHash = this.computeHash(body);
    const prev = this._sessions.get(sessionId);
    this._sessions.set(sessionId, { hash: currHash, updatedAt: now });

    if (!prev) return { status: 'first', curr_hash: currHash };
    if (prev.hash === currHash) return { status: 'stable', curr_hash: currHash };
    return { status: 'drifted', prev_hash: prev.hash, curr_hash: currHash };
  }

  /** Remove sessions not updated within ttlMs. */
  _evict(now) {
    for (const [id, entry] of this._sessions) {
      if (now - entry.updatedAt > this._ttlMs) this._sessions.delete(id);
    }
  }

  /** Number of active sessions (for testing/observability). */
  get sessionCount() {
    return this._sessions.size;
  }
}
