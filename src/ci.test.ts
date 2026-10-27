import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (file: string) => readFileSync(join(import.meta.dirname, '..', file), 'utf8');

describe('CI workflow', () => {
  // Dependabot bumps @playwright/test in the lockfile but never the container image, and a mismatched image has no browsers for the installed Playwright.
  // Dependabotはロックファイルの@playwright/testを更新してもコンテナイメージは更新せず、版がずれるとイメージに該当するブラウザがないため照合する。
  it('runs E2E in the Playwright image of the locked Playwright version', () => {
    const image = read('.github/workflows/ci.yml').match(/image: mcr\.microsoft\.com\/playwright:v([^-\s]+)-/)?.[1];
    const locked = read('pnpm-lock.yaml').match(/^ {2}playwright@([^:]+):$/m)?.[1];
    expect(locked).toBeDefined();
    expect(image).toBe(locked);
  });
});
