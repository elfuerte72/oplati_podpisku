import type { LintResult } from './types.ts';

/**
 * Отчёт линта в ОДНОМ формате: его читает и модель в круге правок, и владелец,
 * когда пост не прошёл. Два формата означали бы, что модель правит по одному
 * тексту, а человек видит другой.
 */
export function formatLint(result: LintResult): string {
  const lines = [
    ...result.errors.map((finding) => `ОШИБКА: ${finding.message}`),
    ...result.warnings.map((finding) => `ВНИМАНИЕ: ${finding.message}`),
  ];
  return lines.join('\n');
}

/** Прошёл ли пост линт. Предупреждения не блокируют: они для автора и владельца. */
export function lintPassed(result: LintResult): boolean {
  return result.errors.length === 0;
}
