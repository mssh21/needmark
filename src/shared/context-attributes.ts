/** An allowlist rather than all attributes, because form values and inline handlers can carry user data or code. / フォームの値やインラインハンドラーは利用者のデータやコードを含み得るため、全属性ではなく許可リストにしている。 */
export const DEFAULT_CONTEXT_ATTRIBUTES = ['id', 'class', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-component', 'name', 'role', 'aria-label', 'aria-labelledby', 'href', 'alt', 'title'] as const;

/** Selectors, saved identity checks and JSX verification share this one order so they never disagree about which marker wins. / セレクター・保存済みの同一性確認・JSX照合で同じ優先順位を共有し、どの識別子を採るかが食い違わないようにする。 */
export const DEFAULT_IDENTIFYING_ATTRIBUTES = ['id', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-component'] as const;
export function identifyingContextAttributes(value?: unknown): string[] {
  return [...DEFAULT_IDENTIFYING_ATTRIBUTES, ...normalizeContextAttributes(value)];
}

export function isContextAttributeName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z][a-z0-9-]{0,99}$/.test(name)
    && !['value', 'nonce', 'srcdoc', 'style'].includes(name) && !name.startsWith('on')
    && !name.startsWith('data-needmark') && !name.startsWith('data-needback');
}

export function normalizeContextAttributes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('contextAttributes must be an array of attribute names.');
  const defaults = new Set<string>(DEFAULT_CONTEXT_ATTRIBUTES);
  const extra = new Set<string>();
  for (const name of value) {
    if (!isContextAttributeName(name)) {
      throw new TypeError('contextAttributes contains an unsupported attribute name.');
    }
    if (!defaults.has(name)) extra.add(name);
    if (extra.size > 6) throw new TypeError('contextAttributes supports at most 6 additional attributes.');
  }
  return [...extra];
}
