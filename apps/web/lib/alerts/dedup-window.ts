import 'server-only';

/**
 * Окно дедупликации DM-алертов на warm-инстансе (best-effort, как и весь
 * механизм notifyOps-дедупов: proxy-health, payment-conversion, unknown-status).
 *
 * Вынесен хелпером, когда копий связки «Map + prune-on-write + resetForTests»
 * стало четыре (ревью части 2 антифрод-трека). Существующие модули на него
 * НЕ переведены намеренно — денежные пути не трогаем ради красоты; новые
 * потребители используют его.
 */
export class DedupWindow {
  private readonly windowMs: number;
  /**
   * Ключ -> момент, КОГДА окно освободится (а не момент отправки).
   *
   * ⚠️ Хранить момент отправки нельзя. Окно задаётся на вызов, экземпляр один
   * на все события, и чистка при записи шла по окну ВЫЗЫВАЮЩЕГО: часовое
   * уведомление о холде через два часа вычищало запись суточного
   * предупреждения о балансе — и то начинало уходить каждые пять минут, то
   * есть ровно так, как алёрт перестают читать. Со сроком ВНУТРИ записи
   * чистка корректна при любом наборе окон.
   */
  private readonly expiresAt = new Map<string, number>();

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /**
   * true — окно свободно, событие фиксируется за вызывающим (слать можно);
   * false — в окне уже слали.
   *
   * `windowMs` можно переопределить на вызов: у разных событий разная цена
   * повтора, а окно у экземпляра одно. Без этого «раз в сутки» и «раз в час»
   * отличались бы только текстом ключа — и оба шумели бы раз в час.
   */
  shouldSend(key: string, now: number = Date.now(), windowMs: number = this.windowMs): boolean {
    if (!this.isFree(key, now)) return false;
    this.record(key, now, windowMs);
    return true;
  }

  /**
   * Свободно ли окно — БЕЗ фиксации за вызывающим.
   *
   * Нужно там, где отправка может не состояться: занять окно до попытки значит
   * получить час молчания при живой аварии (база моргнула, все получатели дали
   * 403). Вызывающий проверяет `isFree`, отправляет и фиксирует `record` только
   * по факту доставки.
   *
   * Окна здесь нет намеренно: срок записан при `record` тем, кто знал цену
   * повтора своего события.
   */
  isFree(key: string, now: number = Date.now()): boolean {
    const expires = this.expiresAt.get(key);
    return expires === undefined || now >= expires;
  }

  /**
   * Зафиксировать отправку. Заодно чистит протухшие записи: событие редкое,
   * отдельный таймер ради него не нужен, а без чистки Map росла бы всё время
   * жизни процесса.
   */
  record(key: string, now: number = Date.now(), windowMs: number = this.windowMs): void {
    for (const [k, expires] of this.expiresAt) {
      if (expires <= now) this.expiresAt.delete(k);
    }
    this.expiresAt.set(key, now + windowMs);
  }

  /** Только для unit-тестов. */
  resetForTests(): void {
    this.expiresAt.clear();
  }
}
