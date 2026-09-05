import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { NOTE_KIND_CLASS } from '@/lib/panel/class-names';
import { SUPPORT_NOT_RECORDED_TEXT } from '@/lib/panel/labels';

import { PanelNote } from './PanelNote';

/**
 * Отклик формы (вариант A дизайн-аудита, тикет 05).
 *
 * Проверяется то, что ломается молча: предупреждение, покрашенное как отказ,
 * и тихая строка, которую не объявляет программа чтения с экрана. И то и
 * другое выглядит работающим — и то и другое ведёт человека не туда.
 */
describe('строка отклика формы', () => {
  it('успех, предупреждение и отказ — три РАЗНЫХ класса', () => {
    // Предупреждение «клиенту отправлено, но в переписку не записалось»
    // красилось классом отказа и звало повторить отправку: клиент получал
    // второе сообщение.
    const classes = new Set(Object.values(NOTE_KIND_CLASS));
    expect(classes.size).toBe(3);
    expect(NOTE_KIND_CLASS.warn).not.toBe(NOTE_KIND_CLASS.error);
  });

  it('строку объявляет программа чтения с экрана', () => {
    // Тихое сообщение без `role="status"` для незрячего сотрудника равно
    // молчанию — а молчание здесь и было исходной бедой.
    const html = renderToStaticMarkup(
      createElement(PanelNote, { kind: 'ok' }, 'Ответ отправлен клиенту.'),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it('предупреждение о незаписанном ответе не зовёт повторить отправку', () => {
    // Текст обязан говорить, что сообщение УШЛО: повтор пришлёт клиенту дубль.
    expect(SUPPORT_NOT_RECORDED_TEXT).toContain('отправлено');
    expect(SUPPORT_NOT_RECORDED_TEXT).toContain('Повторять не нужно');
  });
});
