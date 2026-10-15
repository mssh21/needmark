export type NeedMarkLanguage = 'en' | 'ja';

export function isNeedMarkLanguage(value: unknown): value is NeedMarkLanguage {
  return value === 'en' || value === 'ja';
}
