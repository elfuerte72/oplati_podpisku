import type { PanelHelpCard } from '@/lib/panel/labels';

/**
 * Справка экрана: «как этот экран устроен», свёрнутая по умолчанию.
 *
 * Панель знает про заказы много такого, чего не видно из таблицы: почему счёт
 * живёт час, чем «Истёк срок» отличается от «Ошибки», какой статус означает
 * деньги на холде у банка. Пока этого нет на экране, знание живёт в голове
 * владельца — и новый менеджер спрашивает его в переписке.
 *
 * `<details>` без единой строки скрипта: состояние нужно на один сеанс чтения,
 * а раскрывашка обязана работать и в потоковой отдаче, до гидратации.
 */
export function PanelHelp({ title, hint, cards }: { title: string; hint: string; cards: readonly PanelHelpCard[] }) {
  return (
    <details className="panel-card panel-help">
      <summary className="panel-help__summary">
        <span className="panel-help__title">{title}</span>
        <span className="panel-muted"> {hint}</span>
      </summary>
      <div className="panel-help__cards">
        {cards.map((card) => (
          <section key={card.title}>
            <h2 className="panel-help__card-title">{card.title}</h2>
            <p className="panel-muted">{card.body}</p>
          </section>
        ))}
      </div>
    </details>
  );
}
