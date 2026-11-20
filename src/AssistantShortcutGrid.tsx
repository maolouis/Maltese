import type { MutableRefObject, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import type { CustomShortcut } from "./assistantSupport";

type ShortcutCard = {
  key: string;
  kind: "tool" | "discovered" | "custom";
  label: string;
  detail: string;
  detailTitle?: string;
  path?: string;
  actionId?: string;
  tool?: string;
};

type AssistantShortcutGridProps = {
  shortcutCards: ShortcutCard[];
  suppressShortcutClickRef: MutableRefObject<boolean>;
  draggingShortcutKey: string | null;
  launchingKey: string | null;
  beginShortcutDrag: (event: ReactPointerEvent<HTMLDivElement>, key: string) => void;
  handleAction: (tool: string, label: string) => void;
  launchPath: (label: string, path: string) => void;
  renderIcon: (path: string) => ReactNode;
  hideShortcutAction: (id: string, label: string) => void;
  hideShortcut: (label: string, path: string) => void;
  persistCustomShortcuts: (next: CustomShortcut[]) => void;
  customShortcuts: CustomShortcut[];
};

export function AssistantShortcutGrid({
  shortcutCards,
  suppressShortcutClickRef,
  draggingShortcutKey,
  launchingKey,
  beginShortcutDrag,
  handleAction,
  launchPath,
  renderIcon,
  hideShortcutAction,
  hideShortcut,
  persistCustomShortcuts,
  customShortcuts,
}: AssistantShortcutGridProps) {  return (
      <div
        className="assistant-panel__grid"
        onClickCapture={(event) => {
          // 刚拖动过的那一次 click 不当作“启动”。
          if (suppressShortcutClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {shortcutCards.map((card) => {
          const launching = card.kind === "tool"
            ? launchingKey === `tool:${card.actionId}`
            : launchingKey === card.path;
          return (
            <div
              key={card.key}
              data-shortcut-key={card.key}
              data-window-drag="false"
              title={shortcutCards.length > 1 ? "按住卡片拖动可以调整顺序" : undefined}
              className={`assistant-card assistant-card--custom${draggingShortcutKey === card.key ? " assistant-card--dragging" : ""}`}
              onPointerDown={(event) => beginShortcutDrag(event, card.key)}
            >
              <button
                type="button"
                className="assistant-card__launch"
                data-window-drag="false"
                disabled={Boolean(launching)}
                onClick={() => {
                  if (card.kind === "tool" && card.tool) {
                    handleAction(card.tool, card.label);
                  } else if (card.path) {
                    launchPath(card.label, card.path);
                  }
                }}
              >
                {card.path ? renderIcon(card.path) : null}
                <span className="assistant-card__copy">
                  <strong title={card.label}>{card.label}</strong>
                  <small title={card.detailTitle}>
                    {launching ? "正在启动…" : card.detail}
                  </small>
                </span>
                {launching ? (
                  <Loader2 className="assistant-card__spin" size={14} strokeWidth={1.8} aria-hidden="true" />
                ) : (
                  <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className="assistant-card__remove"
                title={card.kind === "tool"
                  ? "从快捷入口移除"
                  : card.kind === "discovered"
                    ? "从列表移除（不删除桌面文件）"
                    : "删除这个快捷方式"}
                aria-label={card.kind === "tool"
                  ? `从快捷入口移除 ${card.label}`
                  : `移除 ${card.label}`}
                onClick={() => {
                  if (card.kind === "tool" && card.actionId) {
                    hideShortcutAction(card.actionId, card.label);
                  } else if (card.kind === "discovered" && card.path) {
                    hideShortcut(card.label, card.path);
                  } else if (card.path) {
                    persistCustomShortcuts(customShortcuts.filter((item) => item.path !== card.path));
                  }
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
  );
}