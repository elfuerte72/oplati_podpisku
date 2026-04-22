import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Оплати подписки',
  description:
    'Сервис оплаты иностранных подписок (Claude, Netflix, ChatGPT, Airbnb и др.) для русскоязычных пользователей. Рубли, СБП, крипта.',
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
        {children}
      </body>
    </html>
  );
}
