import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_ATTRIBUTES, DEFAULT_IDENTIFYING_ATTRIBUTES, identifyingContextAttributes, normalizeContextAttributes } from './context-attributes.js';

describe('custom context attributes', () => {
  it('accepts developer identifiers without consuming slots for built-in or repeated names', () => {
    const extra = Array.from({ length: 6 }, (_, index) => `data-review-${index}`);
    expect(normalizeContextAttributes([...DEFAULT_CONTEXT_ATTRIBUTES, ...extra, ...extra])).toEqual(extra);
    expect(new Set([...DEFAULT_CONTEXT_ATTRIBUTES, ...normalizeContextAttributes(extra)]).size).toBe(20);
    expect(normalizeContextAttributes(undefined)).toEqual([]);
    expect(normalizeContextAttributes([])).toEqual([]);
  });

  it.each(['value', 'nonce', 'srcdoc', 'style', 'onclick', 'onchange', 'data-needmark', 'data-needmark-token', 'data-needmark-source', 'data-needback-token',
    'Data-Key', ' data-key', 'data-key ', 'data:key', '', 'a'.repeat(101), 1, null])('rejects unsafe or malformed configuration %j', (name) => {
    expect(() => normalizeContextAttributes([name])).toThrow('unsupported attribute name');
  });

  it('rejects an unbounded capture configuration before it can exceed the saved-context record limit', () => {
    expect(() => normalizeContextAttributes(Array.from({ length: 7 }, (_, index) => `data-review-${index}`))).toThrow('at most 6');
    expect(() => normalizeContextAttributes('data-review-id')).toThrow('array');
    expect(() => normalizeContextAttributes(null)).toThrow('array');
  });
});


describe('identifying attribute policy', () => {
  it('keeps strong default precedence and adds only normalized configured extras', () => {
    expect(DEFAULT_IDENTIFYING_ATTRIBUTES).toEqual(['id','data-testid','data-test','data-qa','data-cy','data-component']);
    expect(identifyingContextAttributes(['data-ticket','id','data-cy','data-ticket'])).toEqual([...DEFAULT_IDENTIFYING_ATTRIBUTES,'data-ticket']);
    expect(identifyingContextAttributes()).toEqual([...DEFAULT_IDENTIFYING_ATTRIBUTES]);
  });
});


it('identifying attributes reuse validation, bounded slots and do not mutate developer configuration', () => {
  const extra = Array.from({length:6},(_,index)=>`data-review-${index}`);
  const config = Object.freeze([...DEFAULT_CONTEXT_ATTRIBUTES,...extra,...extra]);
  expect(identifyingContextAttributes(config)).toEqual([...DEFAULT_IDENTIFYING_ATTRIBUTES,...extra]);
  expect(config).toEqual([...DEFAULT_CONTEXT_ATTRIBUTES,...extra,...extra]);
  expect(() => identifyingContextAttributes([...extra,'data-seventh'])).toThrow('at most 6');
  for (const invalid of [['value'],['data-needmark-token'],['Data-Key'],'data-ticket',null]) expect(() => identifyingContextAttributes(invalid)).toThrow();
});

it('shares the same safe attribute-name policy with saved-value consumers without applying configuration slot limits', async () => {
  const { isContextAttributeName } = await import('./context-attributes.js');
  const safe = [...DEFAULT_CONTEXT_ATTRIBUTES, ...Array.from({ length: 20 }, (_, index) => `data-review-${index}`), 'a'.repeat(100)];
  for (const name of safe) expect(isContextAttributeName(name)).toBe(true);
  for (const name of ['value', 'nonce', 'srcdoc', 'style', 'onclick', 'on', 'data-needmark-private', 'data-needback-token',
    'data-Key', 'data:key', '__proto__', ' data-key', 'a'.repeat(101), '', 1, null, {}, undefined]) expect(isContextAttributeName(name)).toBe(false);
});
