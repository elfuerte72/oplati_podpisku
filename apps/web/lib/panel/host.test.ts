import { describe, expect, it } from 'vitest';

import { decidePanelHost } from './host';

/**
 * Гейт по хосту. Главное свойство — направление отказа при ПОТЕРЯННОЙ
 * переменной: на проде панель закрывается, а не выходит на публичный домен.
 *
 * Прецедент прямо в этом репозитории: `CLIENT_IP_MODE` годами имел «удобный»
 * дефолт, и его потеря молча снимала защиту (CWE-348), а правка env через API
 * Dokploy перезаписывает блок ЦЕЛИКОМ — потерять переменную легко.
 */
describe('decidePanelHost', () => {
  it('свой хост пускает', () => {
    expect(
      decidePanelHost({
        host: 'admin.oplatishka.com',
        expected: 'admin.oplatishka.com',
        isProduction: true,
      }),
    ).toBe('allow');
  });

  it('порт не мешает — наружу смотрит 443, внутрь что угодно', () => {
    expect(
      decidePanelHost({
        host: 'admin.oplatishka.com:3000',
        expected: 'admin.oplatishka.com',
        isProduction: true,
      }),
    ).toBe('allow');
  });

  it('регистр и пробелы не мешают', () => {
    expect(
      decidePanelHost({
        host: ' Admin.Oplatishka.COM ',
        expected: 'admin.oplatishka.com',
        isProduction: true,
      }),
    ).toBe('allow');
  });

  it('публичный домен закрыт', () => {
    expect(
      decidePanelHost({
        host: 'www.oplatishka.com',
        expected: 'admin.oplatishka.com',
        isProduction: true,
      }),
    ).toBe('deny');
  });

  it('поддомен-однофамилец не проходит', () => {
    expect(
      decidePanelHost({
        host: 'evil-admin.oplatishka.com',
        expected: 'admin.oplatishka.com',
        isProduction: true,
      }),
    ).toBe('deny');
  });

  it('без заголовка Host — отказ', () => {
    expect(
      decidePanelHost({ host: null, expected: 'admin.oplatishka.com', isProduction: true }),
    ).toBe('deny');
  });

  it('ПОТЕРЯННАЯ переменная на проде ЗАКРЫВАЕТ панель, а не открывает', () => {
    expect(decidePanelHost({ host: 'www.oplatishka.com', expected: undefined, isProduction: true }))
      .toBe('deny');
    expect(decidePanelHost({ host: 'admin.oplatishka.com', expected: '', isProduction: true }))
      .toBe('deny');
  });

  it('в разработке гейт выключен — localhost не должен закрывать панель на своей машине', () => {
    expect(
      decidePanelHost({ host: 'localhost:3000', expected: undefined, isProduction: false }),
    ).toBe('allow_dev');
  });

  it('в разработке заданный хост всё равно соблюдается', () => {
    expect(
      decidePanelHost({
        host: 'localhost:3000',
        expected: 'admin.oplatishka.com',
        isProduction: false,
      }),
    ).toBe('deny');
  });
});
