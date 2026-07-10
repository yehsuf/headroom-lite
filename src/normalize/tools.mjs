/**
 * Normalize tools[] for prompt-cache stability.
 *
 * Without normalization, tool reordering (by different callers or SDK versions)
 * changes the cache prefix hash and destroys cache hit rates.
 *
 * Strategy (matching headroom PR-E1/E2):
 *   1. Sort tools[] alphabetically by tool name.
 *   2. Recursively sort all JSON object keys in input_schema / function.parameters.
 *
 * Safety invariant: if ANY tool carries a cache_control marker at the tool level,
 * skip sorting entirely — the caller has intentionally positioned that tool to
 * set the cache freeze point, and reordering would move the marker.
 */

/**
 * Sort JSON Schema object keys recursively.
 * Non-objects and arrays pass through unchanged at the top level,
 * but array items that are plain objects have their keys sorted.
 * @param {*} value
 * @returns {*}
 */
export function sortSchemaKeys(value) {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? sortSchemaKeys(item)
        : item,
    );
  }

  const sorted = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = sortSchemaKeys(value[key]);
  }
  return sorted;
}

/**
 * Normalize a tools array for stable prompt-cache keys.
 *
 * @param {Array|null|undefined} tools
 * @returns {Array|null|undefined}
 */
export function normalizeTools(tools) {
  if (tools == null) return tools;
  if (tools.length === 0) return tools;

  // If any tool has a cache_control marker, preserve order entirely.
  if (tools.some((t) => t?.cache_control != null)) return tools;

  const getName = (t) => t?.name ?? t?.function?.name ?? '';

  const sorted = [...tools].sort((a, b) => getName(a).localeCompare(getName(b)));

  return sorted.map((tool) => {
    // Anthropic format: { name, input_schema }
    if (tool.input_schema != null) {
      return { ...tool, input_schema: sortSchemaKeys(tool.input_schema) };
    }
    // OpenAI format: { type: 'function', function: { name, parameters } }
    if (tool.function?.parameters != null) {
      return {
        ...tool,
        function: { ...tool.function, parameters: sortSchemaKeys(tool.function.parameters) },
      };
    }
    return tool;
  });
}
