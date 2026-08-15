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
   * false — в окне уже слали. Заодно чистит протухшие записи: событие редкое,
   * отдельный таймер ради него не нужен, а без чистки Map росла бы всё время
   * жизни процесса.
   */
  shouldSend(key: string, now: number = Date.now()): boolean {
    const last = this.sentAt.get(key) ?? 0;
    if (now - last < this.windowMs) return false;
    for (const [k, at] of this.sentAt) {
      if (now - at >= this.windowMs) this.sentAt.delete(k);
    }
    this.sentAt.set(key, now);
    return true;
  }

  /** Только для unit-тестов. */
  resetForTests(): void {
    this.sentAt.clear();
  }
}
