import { childLogger } from '@/lib/logger';
import { guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { subscribePanelLive, type PanelLiveSection } from '@/lib/panel/live-events';
import { canAccess } from '@/lib/panel/permissions';

/**
 * GET /api/panel/events — живые события панели (трек panel-live).
 *
 * Server-Sent Events: один HTTP-ответ держится открытым, сервер досылает
 * `event: change` с разделами, в которых что-то изменилось; клиент
 * (`LiveRefresh`) перерисовывает свою страницу через `router.refresh()`.
 * Канал односторонний — панели отвечать по нему нечего, действия идут обычными
 * запросами; в отличие от WebSocket работает через тот же HTTPS и Traefik, а
 * переподключение делает сам браузер (`EventSource`).
 *
 * Гейт — сессия панели (любой вошедший сотрудник: капабилити `desk` есть у
 * всех ролей). Разделы, закрытые роли, из события вырезаются: поток не должен
 * подсказывать оператору, что шевелится в разделах владельца, даже именем.
 *
 * Пинг-комментарий раз в `PANEL_EVENTS_HEARTBEAT_MS` держит соединение живым
 * через Traefik и не доходит до обработчиков клиента. Обрыв (закрыли вкладку,
 * ушли со страницы) снимает подписку — без открытых потоков хаб не слушает
 * базу вовсе.
 *
 * Опрос раз в 25 секунд на клиенте остаётся страховкой: репозиторий сообщает о
 * записи, а не о коммите, и при разрыве стрима перерисовка всё равно придёт.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = childLogger('panel.events');

export const PANEL_EVENTS_HEARTBEAT_MS = 20_000;
const RECONNECT_MS = 3_000;

/**
 * Потолок открытых потоков на процесс. У панели 1–3 человека и по вкладке на
 * каждого; потолок — не про нагрузку, а про утечку: если обрыв соединения
 * когда-нибудь перестанет доходить до обработчика, подписки копились бы до
 * перезапуска, и здесь это стало бы 503 в логе, а не тихим ростом памяти.
 * Опрос раз в 25 с у клиента продолжает работать и при 503.
 */
export const PANEL_EVENTS_MAX_STREAMS = 32;

let openStreams = 0;

const encoder = new TextEncoder();

export async function GET(req: Request): Promise<Response> {
  const guard = await guardPanelOperation('desk');
  if (!guard.ok) return panelGuardResponse(guard);

  const { actor } = guard;
  if (openStreams >= PANEL_EVENTS_MAX_STREAMS) {
    log.warn({ event: 'panel.events.too_many_streams', staffId: actor.id, openStreams });
    return Response.json({ ok: false, error: 'too_many_streams' }, { status: 503 });
  }
  openStreams += 1;
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let cancelStream: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Освободить всё, что держит поток: подписку хаба, пинг, счётчик. Одна
      // точка на оба пути — обрыв запроса (abort) и отмену читателем (cancel).
      const teardown = () => {
        if (closed) return;
        closed = true;
        openStreams -= 1;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        log.info({ event: 'panel.events.closed', staffId: actor.id, openStreams });
      };
      const close = () => {
        if (closed) return;
        teardown();
        try {
          controller.close();
        } catch {
          // Поток уже закрыт читателем — закрывать нечего.
        }
      };
      // Запись в мёртвый поток бросает; из таймера пинга это стало бы
      // необработанным исключением процесса, который принимает вебхуки, —
      // поэтому отказ записи закрывает поток, а не всплывает.
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch (err) {
          log.warn({ event: 'panel.events.write_failed', staffId: actor.id, err });
          close();
        }
      };

      if (req.signal.aborted) {
        close();
        return;
      }
      send(`retry: ${RECONNECT_MS}\n: connected\n\n`);
      unsubscribe = subscribePanelLive((event) => {
        const sections: PanelLiveSection[] = event.sections.filter((section) =>
          canAccess(actor.role, section),
        );
        if (sections.length === 0) return;
        send(`event: change\ndata: ${JSON.stringify({ sections })}\n\n`);
      });
      heartbeat = setInterval(() => send(': ping\n\n'), PANEL_EVENTS_HEARTBEAT_MS);
      req.signal.addEventListener('abort', close);
      log.info({ event: 'panel.events.opened', staffId: actor.id, role: actor.role, openStreams });
      cancelStream = teardown;
    },
    cancel() {
      cancelStream?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      // Прокси не должны копить ответ: Traefik стрим не буферизует, а этот
      // заголовок закрывает вопрос для любого nginx-подобного слоя впереди.
      'x-accel-buffering': 'no',
    },
  });
}
