import { describe, expect, it } from 'vitest';
import {
  WebCryptoPasswordHasher,
  WebCryptoSessionTokenGenerator,
  WebCryptoTokenHasher,
} from '../src/adapters/auth';

describe('authentication crypto adapters', () => {
  it('hashes and verifies passwords without reusing a salt', async () => {
    const hasher = new WebCryptoPasswordHasher({ iterations: 1_000 });
    const first = await hasher.hash('correct horse battery staple');
    const second = await hasher.hash('correct horse battery staple');
    expect(first).not.toBe(second);
    expect(await hasher.verify('correct horse battery staple', first)).toBe(true);
    expect(await hasher.verify('wrong password', first)).toBe(false);
    expect(await hasher.verify('correct horse battery staple', `${first}x`)).toBe(false);
  });

  it('generates opaque high-entropy tokens and only hashes them', async () => {
    const generator = new WebCryptoSessionTokenGenerator();
    const token = generator.generate();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const hash = await new WebCryptoTokenHasher().hash(token);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(hash).not.toContain(token);
  });
});
