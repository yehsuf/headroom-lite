import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { after, before } from 'node:test';
import { normalizeTools, sortSchemaKeys } from '../src/normalize/tools.mjs';
import { startServer } from '../src/server.mjs';

// ─── sortSchemaKeys unit tests ────────────────────────────────────────────────

describe('sortSchemaKeys', () => {
  it('returns non-objects as-is', () => {
    assert.equal(sortSchemaKeys('hello'), 'hello');
    assert.equal(sortSchemaKeys(42), 42);
    assert.equal(sortSchemaKeys(null), null);
    assert.deepEqual(sortSchemaKeys([1, 2, 3]), [1, 2, 3]);
  });

  it('sorts object keys alphabetically', () => {
    const input = { z: 1, a: 2, m: 3 };
    const result = sortSchemaKeys(input);
    assert.deepEqual(Object.keys(result), ['a', 'm', 'z']);
    assert.deepEqual(result, { a: 2, m: 3, z: 1 });
  });

  it('sorts nested object keys recursively', () => {
    const input = {
      properties: {
        z_prop: { type: 'string', description: 'last' },
        a_prop: { type: 'number', description: 'first' },
      },
      type: 'object',
    };
    const result = sortSchemaKeys(input);
    assert.deepEqual(Object.keys(result), ['properties', 'type']);
    assert.deepEqual(Object.keys(result.properties), ['a_prop', 'z_prop']);
    assert.deepEqual(Object.keys(result.properties.a_prop), ['description', 'type']);
  });

  it('preserves array order but sorts keys within array-item objects', () => {
    const input = [
      { z: 1, a: 2 },
      { y: 3, b: 4 },
    ];
    const result = sortSchemaKeys(input);
    assert.deepEqual(result[0], { a: 2, z: 1 });
    assert.deepEqual(result[1], { b: 4, y: 3 });
    // array length and order preserved
    assert.equal(result.length, 2);
  });

  it('passes through arrays of primitives unchanged', () => {
    const input = { enum: ['z', 'a', 'm'] };
    const result = sortSchemaKeys(input);
    assert.deepEqual(result.enum, ['z', 'a', 'm']);
  });
});

// ─── normalizeTools unit tests ────────────────────────────────────────────────

describe('normalizeTools', () => {
  it('returns null as-is', () => {
    assert.equal(normalizeTools(null), null);
  });

  it('returns undefined as-is', () => {
    assert.equal(normalizeTools(undefined), undefined);
  });

  it('returns empty array as-is', () => {
    const arr = [];
    assert.equal(normalizeTools(arr), arr);
  });

  it('is idempotent when tools are already in alphabetical order', () => {
    const tools = [
      { name: 'alpha', input_schema: { type: 'object', properties: {} } },
      { name: 'beta', input_schema: { type: 'object', properties: {} } },
    ];
    const result = normalizeTools(tools);
    assert.deepEqual(result.map((t) => t.name), ['alpha', 'beta']);
  });

  it('sorts tools out of alphabetical order', () => {
    const tools = [
      { name: 'zebra', input_schema: { type: 'object' } },
      { name: 'alpha', input_schema: { type: 'object' } },
      { name: 'mango', input_schema: { type: 'object' } },
    ];
    const result = normalizeTools(tools);
    assert.deepEqual(result.map((t) => t.name), ['alpha', 'mango', 'zebra']);
  });

  it('returns original array unchanged when any tool has cache_control', () => {
    const tools = [
      { name: 'zebra', input_schema: { type: 'object' } },
      { name: 'alpha', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
    ];
    const result = normalizeTools(tools);
    assert.equal(result, tools); // same reference
    assert.deepEqual(result.map((t) => t.name), ['zebra', 'alpha']); // order unchanged
  });

  it('sorts input_schema keys for Anthropic format tools', () => {
    const tools = [
      {
        name: 'search',
        input_schema: {
          type: 'object',
          properties: {
            z_field: { type: 'string' },
            a_field: { type: 'number', description: 'first' },
          },
          required: ['a_field'],
        },
      },
    ];
    const result = normalizeTools(tools);
    assert.deepEqual(Object.keys(result[0].input_schema.properties), ['a_field', 'z_field']);
    assert.deepEqual(Object.keys(result[0].input_schema), ['properties', 'required', 'type']);
  });

  it('sorts function.parameters keys for OpenAI format tools', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: {
            type: 'object',
            properties: {
              unit: { enum: ['celsius', 'fahrenheit'], type: 'string' },
              location: { description: 'City', type: 'string' },
            },
            required: ['location'],
          },
        },
      },
    ];
    const result = normalizeTools(tools);
    const params = result[0].function.parameters;
    assert.deepEqual(Object.keys(params.properties), ['location', 'unit']);
    assert.deepEqual(Object.keys(params), ['properties', 'required', 'type']);
  });

  it('sorts nested schema properties recursively', () => {
    const tools = [
      {
        name: 'complex',
        input_schema: {
          type: 'object',
          properties: {
            outer: {
              type: 'object',
              properties: {
                z_inner: { type: 'string' },
                a_inner: { type: 'boolean' },
              },
            },
          },
        },
      },
    ];
    const result = normalizeTools(tools);
    const innerProps = result[0].input_schema.properties.outer.properties;
    assert.deepEqual(Object.keys(innerProps), ['a_inner', 'z_inner']);
  });

  it('sorts tools with same-prefix names correctly via localeCompare', () => {
    const tools = [
      { name: 'read_file_contents', input_schema: { type: 'object' } },
      { name: 'read_file', input_schema: { type: 'object' } },
      { name: 'read', input_schema: { type: 'object' } },
    ];
    const result = normalizeTools(tools);
    assert.deepEqual(result.map((t) => t.name), ['read', 'read_file', 'read_file_contents']);
  });

  it('does not mutate the input array or tool objects', () => {
    const original = [
      { name: 'z_tool', input_schema: { type: 'object', properties: { z: {}, a: {} } } },
      { name: 'a_tool', input_schema: { type: 'object' } },
    ];
    const firstToolRef = original[0];
    normalizeTools(original);
    assert.equal(original[0], firstToolRef); // array not mutated
    assert.deepEqual(Object.keys(original[0].input_schema.properties), ['z', 'a']); // schema not mutated
  });

  it('handles tools without input_schema or function.parameters', () => {
    const tools = [
      { name: 'z_plain' },
      { name: 'a_plain' },
    ];
    const result = normalizeTools(tools);
    assert.deepEqual(result.map((t) => t.name), ['a_plain', 'z_plain']);
  });

  it('uses OpenAI function name for sorting', () => {
    const tools = [
      { type: 'function', function: { name: 'z_func', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'a_func', parameters: { type: 'object' } } },
    ];
    const result = normalizeTools(tools);
    assert.equal(result[0].function.name, 'a_func');
    assert.equal(result[1].function.name, 'z_func');
  });
});

// ─── Server integration tests ─────────────────────────────────────────────────

describe('POST /v1/compress with tools', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({ host: '127.0.0.1', port: 0, maxBodyBytes: 1024 * 1024 });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const basePayload = {
    format: 'openai',
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'hello' }],
  };

  it('returns normalized_tools sorted when tools[] provided', async () => {
    const payload = {
      ...basePayload,
      tools: [
        { name: 'zebra', input_schema: { type: 'object', properties: { z: {}, a: {} } } },
        { name: 'alpha', input_schema: { type: 'object' } },
      ],
    };

    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok('normalized_tools' in body, 'normalized_tools should be present');
    assert.deepEqual(body.normalized_tools.map((t) => t.name), ['alpha', 'zebra']);
    // 'zebra' is now at index 1 — verify its schema keys were sorted
    assert.deepEqual(Object.keys(body.normalized_tools[1].input_schema.properties), ['a', 'z']);
  });

  it('omits normalized_tools when tools not provided', async () => {
    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(basePayload),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(!('normalized_tools' in body), 'normalized_tools should be absent');
  });

  it('returns normalized_tools in original order when any tool has cache_control', async () => {
    const tools = [
      { name: 'zebra', input_schema: { type: 'object' } },
      { name: 'alpha', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
    ];
    const payload = { ...basePayload, tools };

    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok('normalized_tools' in body, 'normalized_tools should be present');
    assert.deepEqual(body.normalized_tools.map((t) => t.name), ['zebra', 'alpha']); // original order
  });
});
