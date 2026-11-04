import { useMemo } from "react";
import "./DiaryTimeline.css";

export type DiaryEvent = {
  id: string;
  date: string;
  at: number;
  kind: "pet" | "todo";
  text: string;
};

type Props = {
  events: DiaryEvent[];
  title: string;
  empty: string;
  localeTag: string;
};

// 日记页里的小狗日记：把摸头、开始/完成待办按时间排成一条记录。
export function DiaryTimeline({ events, title, empty, localeTag }: Props) {
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(localeTag, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [localeTag],
  );
  const visible = events.slice(-120).reverse();

  return (
    <section className="diary-timeline" aria-label={title}>
      <header className="diary-timeline__head">
        <span>{title}</span>
        <span className="diary-timeline__count">{visible.length}</span>
      </header>
      {visible.length === 0 ? (
        <p className="diary-timeline__empty">{empty}</p>
      ) : (
        <ol className="diary-timeline__list">
          {visible.map((event) => (
            <li className={`diary-timeline__item diary-timeline__item--${event.kind}`} key={event.id}>
              <time dateTime={new Date(event.at).toISOString()}>
                {formatter.format(event.at)}
              </time>
              <span>{event.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}