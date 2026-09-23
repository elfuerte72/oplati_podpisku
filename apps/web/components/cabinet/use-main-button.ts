'use client';

import { useEffect, useRef } from 'react';

import { tolerateTelegram, type TelegramMainButton } from './telegram';

/**
 * Нативная кнопка Telegram внизу экрана — «Оплатить N ₽» на листе заказа (трек
 * miniapp-tabs, тикет 05). Кнопка одна на всё приложение, поэтому хук обязан
 * убрать её за собой: лист закрыли или заказ перестал быть оплатимым — кнопка
 * скрыта и обработчик снят, иначе она «висела» бы на других вкладках и платила
 * бы за заказ, которого на экране уже нет.
 *
 * Повторное нажатие не выставляет второй счёт: на время `busy` кнопка в
 * прогрессе и выключена, а сам обработчик дополнительно гасит повтор (гейт в
 * `CabinetClient.onPay`).
 */
export function useMainButton({
  button,
  visible,
  text,
  busy,
  onClick,
}: {
  /** `null` — клиент Telegram без кнопки (или стенд): экран рисует свою. */
  button: TelegramMainButton | null;
  visible: boolean;
  text: string;
  busy: boolean;
  onClick: () => void;
}): void {
  const clickRef = useRef(onClick);
  useEffect(() => {
    clickRef.current = onClick;
  });

  useEffect(() => {
    if (!button || !visible) return;
    const handler = () => clickRef.current();
    const teal =
      getComputedStyle(document.documentElement).getPropertyValue('--color-teal-primary').trim() ||
      '#268b89';
    tolerateTelegram(() => {
      button.setParams?.({ color: teal, text_color: '#fbfcf7', is_active: true });
      button.onClick?.(handler);
      button.show?.();
    });
    return () => {
      tolerateTelegram(() => {
        button.offClick?.(handler);
        button.hideProgress?.();
        button.hide?.();
      });
    };
  }, [button, visible]);

  useEffect(() => {
    if (!button || !visible) return;
    tolerateTelegram(() => button.setText?.(text));
  }, [button, visible, text]);

  useEffect(() => {
    if (!button || !visible) return;
    tolerateTelegram(() => {
      if (busy) {
        button.showProgress?.(false);
        button.disable?.();
      } else {
        button.hideProgress?.();
        button.enable?.();
      }
    });
  }, [button, visible, busy]);
}
