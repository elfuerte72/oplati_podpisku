import Link from 'next/link';

/**
 * 404 ВНУТРИ панели.
 *
 * Без него опечатка в номере заказа выбрасывала менеджера на клиентскую
 * комикс-страницу «оплати иностранную подписку» со ссылкой на витрину: чужой
 * контекст, чужие шрифты и ни одной кнопки, чтобы вернуться к работе.
 *
 * Меню здесь не рисуем: страница рендерится и тогда, когда актора нет
 * (например, сессия протухла), а тянуть ради 404 запрос в базу незачем.
 */
export default function PanelNotFound() {
  return (
    <div className="panel-login">
      <div className="panel-login-card">
        <div className="panel-card">
          <h1 className="panel-title">Ничего не нашлось</h1>
          <p className="panel-muted">
            Проверь номер заказа — в нём пять символов после `ORD-`. Или вернись к списку.
          </p>
          <p style={{ marginTop: 12 }}>
            <Link href="/admin/orders">К заказам</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
