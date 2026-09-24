/**
 * Адрес Telegram WebApp SDK. Отдельным модулем без `'use client'`: его читают и
 * клиентская загрузка SDK (`telegram.ts`), и серверная страница `/cabinet`,
 * которая ставит браузеру подсказку скачать скрипт заранее. Экспорт из
 * клиентского модуля на сервере приходит клиентской ссылкой, а не строкой.
 */
export const TELEGRAM_SDK_URL = 'https://telegram.org/js/telegram-web-app.js';
