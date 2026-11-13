// 固定在桌面的「待办」标签页。
//
// 待办的状态本来住在主窗口里，这里通过 localStorage（`focusd-island-todos`）读写同一份数据：
// 两边任意一端修改都会触发 storage 事件，另一个窗口据此重新加载，避免出现两份真相。
import { useCallback, useEffect, useState } from "react";
import { Check, Plus } from "lucide-react";

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt?: number;
  startedAt?: number | null;
  activeSince?: number | null;
};

const TODOS_STORAGE_KEY = "focusd-island-todos";
const ACTIVE_TODO_STORAGE_KEY = "focusd-island-active-todo";

function readTodos(): Todo[] {
  try {
    const raw = window.localStorage.getItem(TODOS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): Todo | null => {
        if (!item || typeof item !== "object") return null;
        const todo = item as Partial<Todo>;
        if (typeof todo.id !== "string" || typeof todo.title !== "string") return null;
        return {
          id: todo.id,
          title: todo.title,
          completed: Boolean(todo.completed),
          createdAt: todo.createdAt,
          startedAt: todo.startedAt ?? null,
          activeSince: todo.activeSince ?? null,
        };
      })
      .filter((todo): todo is Todo => Boolean(todo));
  } catch {
    return [];
  }
}

function writeTodos(todos: Todo[]) {
  try {
    window.localStorage.setItem(TODOS_STORAGE_KEY, JSON.stringify(todos));
  } catch {
    // 忽略写入失败
  }
}

function readActiveId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_TODO_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function PinnedTodo() {
  const [todos, setTodos] = useState<Todo[]>(readTodos);
  const [activeId, setActiveId] = useState<string | null>(readActiveId);
  const [draft, setDraft] = useState("");

  const reload = useCallback(() => {
    setTodos(readTodos());
    setActiveId(readActiveId());
  }, []);

  useEffect(() => {
    reload();
    // 另一个窗口改了就跟着刷新。
    const onStorage = (event: StorageEvent) => {
      if (event.key === TODOS_STORAGE_KEY || event.key === ACTIVE_TODO_STORAGE_KEY) {
        reload();
      }
    };
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(reload, 3000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }, [reload]);

  const addTodo = () => {
    const title = draft.trim();
    if (!title) return;
    const next: Todo[] = [
      ...todos,
      {
        id: `pinned-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        completed: false,
        createdAt: Date.now(),
        startedAt: null,
        activeSince: null,
      },
    ];
    writeTodos(next);
    setTodos(next);
    setDraft("");
  };

  const toggle = (id: string) => {
    const next = todos.map((todo) =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo,
    );
    writeTodos(next);
    setTodos(next);
  };

  const setActive = (id: string) => {
    const next = todos.map((todo) =>
      todo.id === id && !todo.completed
        ? { ...todo, startedAt: todo.startedAt ?? Date.now(), activeSince: Date.now() }
        : todo,
    );
    writeTodos(next);
    setTodos(next);
    try {
      window.localStorage.setItem(ACTIVE_TODO_STORAGE_KEY, id);
    } catch {
      // 忽略
    }
    setActiveId(id);
  };

  const pending = todos.filter((todo) => !todo.completed);
  const done = todos.filter((todo) => todo.completed);

  return (
    <div className="pinned-todo">
      <div className="pinned-todo__add">
        <input
          value={draft}
          placeholder="加一条待办，回车确认"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addTodo();
          }}
        />
        <button type="button" onClick={addTodo} disabled={!draft.trim()}>
          <Plus size={14} aria-hidden="true" />
          添加
        </button>
      </div>

      {pending.length === 0 && done.length === 0 ? (
        <p className="pinned-todo__empty">今天还没有待办，写一条开始吧。</p>
      ) : (
        <ul className="pinned-todo__list">
          {pending.map((todo) => (
            <li
              key={todo.id}
              className={`pinned-todo__item${todo.id === activeId ? " is-active" : ""}`}
            >
              <button
                type="button"
                className="pinned-todo__check"
                aria-label={todo.completed ? "标记为未完成" : "标记为完成"}
                onClick={() => toggle(todo.id)}
              >
                <Check size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="pinned-todo__title"
                title="设为进行中"
                onClick={() => setActive(todo.id)}
              >
                {todo.title}
              </button>
              {todo.id === activeId && <span className="pinned-todo__badge">进行中</span>}
            </li>
          ))}
          {done.length > 0 && (
            <li className="pinned-todo__divider">已完成 {done.length} 条</li>
          )}
          {done.map((todo) => (
            <li key={todo.id} className="pinned-todo__item pinned-todo__item--done">
              <button
                type="button"
                className="pinned-todo__check is-checked"
                aria-label="标记为未完成"
                onClick={() => toggle(todo.id)}
              >
                <Check size={13} aria-hidden="true" />
              </button>
              <span className="pinned-todo__title">{todo.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}