import Link from 'next/link';

import { comicButtonClassName } from '@/components/comic';
import { ErrorScene } from '@/components/comic/ErrorScene';

/** 404 в стиле комикса: Оплатишка озадаченно смотрит на цифры. */
export default function NotFound() {
  return (
    <ErrorScene
      code="404"
      title="Хм… такой страницы нет"
      text="Я всё обыскал — тут пусто. Зато на главной можно оплатить любую иностранную подписку за пару минут."
    >
      <Link href="/" className={comicButtonClassName('primary')}>
        На главную
      </Link>
    </ErrorScene>
  );
}
