// Self-identification for headroom-lite. Every response that headroom-lite
// GENERATES itself (health/stats/metrics/compress, 4xx/5xx errors, and
// locally-generated proxy gateway errors) carries this header so any consumer
// or proxy can distinguish this deterministic reimplementation from upstream
// classic headroom. It is deliberately NOT applied to forwarded upstream
// provider responses, which must stay byte-for-byte opaque.
export const IMPLEMENTATION_NAME = 'headroom-lite';
export const IMPLEMENTATION_HEADER = 'x-headroom-implementation';
