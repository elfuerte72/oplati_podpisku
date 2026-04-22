export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-24">
      <div className="max-w-xl text-center space-y-6">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Оплати подписки
        </h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Сервис оплаты иностранных подписок для русскоязычных пользователей. Скоро.
        </p>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          Пока сайт в разработке — напишите нашему боту в Telegram.
        </p>
      </div>
    </main>
  );
}
