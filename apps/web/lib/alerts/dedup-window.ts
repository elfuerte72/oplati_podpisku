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
  private readonly sentAt = new Map<string, number>();

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
    if (!this.isFree(key, now, windowMs)) return false;
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
   */
  isFree(key: string, now: number = Date.now(), windowMs: number = this.windowMs): boolean {
    const last = this.sentAt.get(key) ?? 0;
    return now - last >= windowMs;
  }

  /**
   * Зафиксировать отправку. Заодно чистит протухшие записи: событие редкое,
   * отдельный таймер ради него не нужен, а без чистки Map росла бы всё время
   * жизни процесса.
   */
  record(key: string, now: number = Date.now(), windowMs: number = this.windowMs): void {
    for (const [k, at] of this.sentAt) {
      if (now - at >= windowMs) this.sentAt.delete(k);
    }
    this.sentAt.set(key, now);
  }

  /** Только для unit-тестов. */
  resetForTests(): void {
    this.sentAt.clear();
  }
}
