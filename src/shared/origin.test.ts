import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from './origin.js';

describe('allowed origins', () => {
  it('matches a configured list exactly', () => {
    expect(isAllowedOrigin('http://192.168.1.5:5173', ['http://192.168.1.5:5173'])).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', ['http://192.168.1.5:5173'])).toBe(false);
  });

  it.each(['http://localhost:5173', 'https://127.0.0.1:4190', 'http://[::1]:3000', 'http://localhost'])('accepts loopback %s without a list', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  it.each(['http://evil.example:5173', 'http://localhost.evil.example:5173', 'http://192.168.1.5:5173', 'http://localhost:5173/', 'ws://localhost:5173', 'http://', ''])('rejects %j without a list', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });
});
