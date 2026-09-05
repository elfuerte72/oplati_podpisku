import type { Metadata } from 'next';
import { Balsamiq_Sans, Rubik } from 'next/font/google';
import Script from 'next/script';
import './globals.css';

// Display: рисованный «комиксовый» гротеск с кириллицей — заголовки, кнопки.
const display = Balsamiq_Sans({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '700'],
  variable: '--font-display-src',
  display: 'swap',
});

// Body/UI: округлый дружелюбный гротеск с кириллицей — текст диалога.
const body = Rubik({
  subsets: ['cyrillic', 'latin'],
  variable: '--font-body-src',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Оплати подписки',
  description:
    'Сервис оплаты иностранных подписок (Claude, ChatGPT, Apple Music, Cursor и др.) для русскоязычных пользователей. Оплата рублями: СБП или карта.',
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      className={`h-full ${display.variable} ${body.variable}`}
      data-theme="dark"
      // До-пейнтовые скрипты theme-init/intro-init дописывают data-theme и
      // data-intro-pending в <html> ДО гидратации — серверный HTML их не знает.
      // Гасим предупреждение только для атрибутов самого <html> (shallow, на
      // потомков не влияет) — канонический приём для анти-FOUC (см. next-themes).
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Применяем сохранённую тему до пейнта (анти-FOUC). beforeInteractive —
            валидный для App Router способ раннего инлайна (вместо raw <script>,
            на который ругается React). */}
        <Script id="theme-init" strategy="beforeInteractive">
          {`try{var t=localStorage.getItem('oplatishka-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}`}
        </Script>
        {/* Анти-FOUC интро: до пейнта помечаем <html>, если пользователь ещё не
            видел интро, — CSS прячет главный shell, пока оверлей не смонтируется
            и не закроется. Иначе на первом кадре мигает главный экран, а поверх
            него доезжает интро (флаг читается только на клиенте, после гидратации). */}
        <Script id="intro-init" strategy="beforeInteractive">
          {`try{if(localStorage.getItem('oplatishka_intro_seen')===null){document.documentElement.dataset.introPending='1';}}catch(e){}`}
        </Script>
        {children}
      </body>
    </html>
  );
}
