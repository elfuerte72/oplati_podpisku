import { startApp } from './app.ts';
import { EnvError, loadEnv, type SmmEnv } from './config/env.ts';
import { createLogger } from './logger.ts';

/**
 * Точка входа процесса. Всё, что делает: разбирает env, поднимает логгер,
 * собирает приложение и корректно гасит его по сигналу. Dokploy при редеплое
 * шлёт SIGTERM и убивает контейнер через 10 секунд — незакрытая база теряет
 * последние записи WAL, а живой long polling оставляет за собой конфликт
 * `getUpdates` с новым контейнером.
 */
/** Сколько ждём корректной остановки. Dokploy убивает контейнер через 10 секунд. */
const SHUTDOWN_DEADLINE_MS = 8000;

function bootstrap(): void {
  let env: SmmEnv;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      // Логгера ещё нет, а понятная причина нужна в docker logs первой строкой.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: env.logLevel });
  const app = startApp({ env, logger });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      // Второй сигнал — это «хватит ждать»: зависший long polling иначе доживёт
      // до SIGKILL, и база закроется не по своей воле.
      logger.warn({ signal }, 'повторный сигнал: выходим не дожидаясь остановки');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'остановка по сигналу');
    // Сторож на случай, если остановка зависла: выйти самим лучше, чем быть
    // убитым на середине записи в SQLite.
    const deadline = setTimeout(() => {
      logger.error({ signal }, 'остановка не успела за отведённое время');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    app
      .stop()
      .then(() => {
        clearTimeout(deadline);
        process.exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(deadline);
        logger.error({ err: error }, 'остановка прошла с ошибкой');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Необработанное исключение не оставляем процессу в подвешенном состоянии:
  // Dokploy перезапустит контейнер, а молча живой процесс без бота — нет.
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'необработанное исключение');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'необработанный отказ промиса');
    process.exit(1);
  });
}

bootstrap();
