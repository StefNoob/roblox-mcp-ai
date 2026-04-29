import { resolveServerHost } from '../server-config';

describe('resolveServerHost', () => {
  test('defaults to localhost for the MCP HTTP bridge', () => {
    expect(resolveServerHost(undefined)).toBe('127.0.0.1');
    expect(resolveServerHost('')).toBe('127.0.0.1');
    expect(resolveServerHost('   ')).toBe('127.0.0.1');
  });

  test('uses an explicit host override when provided', () => {
    expect(resolveServerHost('0.0.0.0')).toBe('0.0.0.0');
    expect(resolveServerHost('192.168.1.25')).toBe('192.168.1.25');
  });
});
