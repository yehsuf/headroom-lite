/**
 * HTTP client for the LLMLingua Python microservice.
 * Fail-open by default: returns originals with error metadata on any failure.
 */

export async function compressTexts(items, config, { signal } = {}) {
  // items: [{ id, text, kind, targetRate }]
  // Returns: { items: [{ id, text, compressed, originalChars, compressedChars, backend, modelName, error? }] }

  if (!items || items.length === 0) return { items: [] };

  const url = `${config.serviceUrl}/v1/compress-texts`;
  const body = JSON.stringify({
    backend: config.backend,
    model_name: config.modelName,
    target_rate: config.targetRate,
    items: items.map((it) => ({ id: it.id, text: it.text, kind: it.kind })),
  });

  try {
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: combinedSignal,
    });

    if (!res.ok) {
      const err = `HTTP ${res.status}`;
      if (config.failClosed) throw new Error(err);
      return _failOpen(items, err, config);
    }

    const json = await res.json();
    return json;
  } catch (err) {
    if (config.failClosed) throw err;
    return _failOpen(items, err?.message || String(err), config);
  }
}

function _failOpen(items, error, config) {
  return {
    items: items.map((it) => ({
      id: it.id,
      text: it.text,
      compressed: false,
      originalChars: it.text.length,
      compressedChars: it.text.length,
      backend: config.backend,
      modelName: config.modelName,
      error,
    })),
  };
}
