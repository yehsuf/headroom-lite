/**
 * Parse a string env-var value as a positive integer.
 * Throws on values that are present but invalid.
 * Falls back to `defaultValue` when the input is absent/empty.
 *
 * @param {string|undefined|null} input
 * @param {number} defaultValue
 * @param {{ allowZero?: boolean }} [opts]
 * @returns {number}
 */
export function parseIntOption(input, defaultValue, { allowZero = false } = {}) {
  if (input === undefined || input === null || input === '') return defaultValue;
  const value = Number.parseInt(String(input), 10);
  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`invalid numeric value: ${input}`);
  }
  return value;
}
