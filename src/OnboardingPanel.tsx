import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bell,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Hand,
  MessageCircleHeart,
  Move,
  Music,
  Sparkles,
} from "lucide-react";
import { useLocale, useTranslation, type LocaleCode } from "./i18n";
import { petAssetUrl } from "./petAssetBase";
import { resolvePetGif } from "./petAssets";
import {
  characterFramesForState,
  savePetCharacter,
  usePetCharacter,
  type PetCharacterId,
} from "./petCharacters";
import {
  DEFAULT_WAKE_SHORTCUT,
  loadWakeShortcut,
  saveWakeShortcut,
} from "./wakeShortcut";
import "./OnboardingPanel.css";

export const ONBOARDING_DONE_KEY = "maltese-onboarding-done";
export const ONBOARDING_OPEN_EVENT = "maltese-open-onboarding";

export const ONBOARDING_STEP_KEYS = [
  "partner",
  "appearance",
  "gestures",
  "features",
  "system",
  "done",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];
export type OnboardingAppearanceMode = "classic" | "liquidGlass";
export type OnboardingFullscreenAvoid = "tuck" | "hide" | "off";
export type OnboardingLockCorner = "" | "tl" | "tr" | "bl" | "br";

export function isOnboardingDone(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_DONE_KEY) === "1";
  } catch {
    return true;
  }
}

export function markOnboardingDone() {
  try {
    window.localStorage.setItem(ONBOARDING_DONE_KEY, "1");
  } catch {
    // 忽略写入失败，下次启动会再次展示向导。
  }
}

export function resetOnboardingDone() {
  try {
    window.localStorage.removeItem(ONBOARDING_DONE_KEY);
  } catch {
    // 忽略删除失败
  }
}

export function formatShortcutCombo(input: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): { combo: string | null; modifierOnly: boolean; missingModifier: boolean } {
  if (["Control", "Alt", "Shift", "Meta"].includes(input.key)) {
    return { combo: null, modifierOnly: true, missingModifier: false };
  }
  const modifiers = [
    input.ctrlKey && "Ctrl",
    input.altKey && "Alt",
    input.shiftKey && "Shift",
    input.metaKey && "Win",
  ].filter(Boolean) as string[];
  if (!modifiers.length) {
    return { combo: null, modifierOnly: false, missingModifier: true };
  }
  const normalizedKey =
    input.key === " "
      ? "Space"
      : input.key.length === 1
        ? input.key.toUpperCase()
        : input.key;
  return {
    combo: [...modifiers, normalizedKey].join("+"),
    modifierOnly: false,
    missingModifier: false,
  };
}

function pickCharacterGif(character: PetCharacterId, state: string): string {
  return (
    characterFramesForState(character, state)[0]
    ?? characterFramesForState(character, "idle")[0]
    ?? resolvePetGif("celebrate")
    ?? petAssetUrl("/assets/pets/rest.gif")
  );
}

export interface OnboardingPanelProps {
  onFinish: () => void;
  onExploreTodo?: () => void;
  locale?: LocaleCode;
  onLocaleChange?: (locale: LocaleCode) => void;
  appearanceMode?: OnboardingAppearanceMode;
  onAppearanceModeChange?: (mode: OnboardingAppearanceMode) => void;
  collapsedScale?: number;
  onCollapsedScaleChange?: (scale: number) => void;
  lockCorner?: OnboardingLockCorner;
  onLockCornerChange?: (corner: OnboardingLockCorner) => void;
  fullscreenAvoid?: OnboardingFullscreenAvoid;
  onFullscreenAvoidChange?: (mode: OnboardingFullscreenAvoid) => void;
}

export function OnboardingPanel({
  onFinish,
  onExploreTodo,
  locale: localeProp,
  onLocaleChange,
  appearanceMode = "classic",
  onAppearanceModeChange,
  collapsedScale = 0.89,
  onCollapsedScaleChange,
  lockCorner = "",
  onLockCornerChange,
  fullscreenAvoid = "tuck",
  onFullscreenAvoidChange,
}: OnboardingPanelProps) {
  const t = useTranslation();
  const localeCtx = useLocale();
  const currentLocale = localeProp ?? localeCtx.locale;
  const switchLocale = onLocaleChange ?? localeCtx.setLocale;

  const petCharacter = usePetCharacter();
  const [step, setStep] = useState(0);

  // 外观与位置本地镜像（即使未传受控回调也可即时高亮反馈）
  const [localAppearance, setLocalAppearance] =
    useState<OnboardingAppearanceMode>(appearanceMode);
  const [localScale, setLocalScale] = useState<number>(collapsedScale);
  const [localCorner, setLocalCorner] = useState<OnboardingLockCorner>(lockCorner);
  const [localFullscreenAvoid, setLocalFullscreenAvoid] =
    useState<OnboardingFullscreenAvoid>(fullscreenAvoid);

  useEffect(() => setLocalAppearance(appearanceMode), [appearanceMode]);
  useEffect(() => setLocalScale(collapsedScale), [collapsedScale]);
  useEffect(() => setLocalCorner(lockCorner), [lockCorner]);
  useEffect(() => setLocalFullscreenAvoid(fullscreenAvoid), [fullscreenAvoid]);

  // Step 2: 手势试玩台状态
  const [activeGesture, setActiveGesture] = useState<
    "click" | "double" | "right" | "drag" | null
  >(null);

  // Step 4: 快捷键与开机自启
  const [wakeShortcut, setWakeShortcut] = useState(loadWakeShortcut);
  const [shortcutError, setShortcutError] = useState("");
  const [shortcutSaved, setShortcutSaved] = useState(false);
  const [launchAtStartup, setLaunchAtStartup] = useState(false);

  useEffect(() => {
    void invoke<boolean>("get_launch_at_startup")
      .then(setLaunchAtStartup)
      .catch(() => setLaunchAtStartup(false));
  }, []);

  const selectCharacter = useCallback((next: PetCharacterId) => {
    savePetCharacter(next);
  }, []);

  const handleAppearance = useCallback(
    (mode: OnboardingAppearanceMode) => {
      setLocalAppearance(mode);
      onAppearanceModeChange?.(mode);
    },
    [onAppearanceModeChange],
  );

  const handleScale = useCallback(
    (scale: number) => {
      setLocalScale(scale);
      onCollapsedScaleChange?.(scale);
    },
    [onCollapsedScaleChange],
  );

  const handleCorner = useCallback(
    (corner: OnboardingLockCorner) => {
      setLocalCorner(corner);
      onLockCornerChange?.(corner);
      void invoke("lock_island_corner", { corner }).catch(() => undefined);
    },
    [onLockCornerChange],
  );

  const handleFullscreenAvoid = useCallback(
    (mode: OnboardingFullscreenAvoid) => {
      setLocalFullscreenAvoid(mode);
      onFullscreenAvoidChange?.(mode);
    },
    [onFullscreenAvoidChange],
  );

  const applyShortcut = useCallback(async (next: string) => {
    try {
      const registered = await invoke<string>("set_wake_shortcut", {
        shortcut: next,
      });
      setWakeShortcut(registered);
      saveWakeShortcut(registered);
      setShortcutError("");
      setShortcutSaved(true);
    } catch (error) {
      setShortcutError(String(error));
      setShortcutSaved(false);
    }
  }, []);

  const recordShortcut = useCallback(
    async (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const parsed = formatShortcutCombo({
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      });
      if (parsed.modifierOnly) {
        return;
      }
      if (parsed.missingModifier || !parsed.combo) {
        setShortcutError(t.onboarding.system.shortcutModifierError);
        setShortcutSaved(false);
        return;
      }
      await applyShortcut(parsed.combo);
    },
    [applyShortcut, t.onboarding.system.shortcutModifierError],
  );

  const applyLaunchAtStartup = useCallback(async (enabled: boolean) => {
    try {
      await invoke("set_launch_at_startup", { enabled });
      setLaunchAtStartup(enabled);
    } catch {
      setLaunchAtStartup(false);
    }
  }, []);

  const characterCards = useMemo(
    () => [
      {
        id: "xiaobai" as PetCharacterId,
        name: t.onboarding.partner.characters.xiaobaiName,
        desc: t.onboarding.partner.characters.xiaobaiDesc,
        gif: pickCharacterGif("xiaobai", "happy"),
      },
      {
        id: "xiaojimao" as PetCharacterId,
        name: t.onboarding.partner.characters.xiaojimaoName,
        desc: t.onboarding.partner.characters.xiaojimaoDesc,
        gif: pickCharacterGif("xiaojimao", "happy"),
      },
      {
        id: "duo" as PetCharacterId,
        name: t.onboarding.partner.characters.duoName,
        desc: t.onboarding.partner.characters.duoDesc,
        gif: pickCharacterGif("duo", "happy"),
      },
    ],
    [t.onboarding.partner.characters],
  );

  const gesturePreview = useMemo(() => {
    switch (activeGesture) {
      case "click":
        return {
          gif: pickCharacterGif(petCharacter, "pet"),
          bubble: t.onboarding.gestures.clickBubble,
        };
      case "double":
        return {
          gif: pickCharacterGif(petCharacter, "celebrate"),
          bubble: t.onboarding.gestures.doubleBubble,
        };
      case "right":
        return {
          gif: pickCharacterGif(petCharacter, "love"),
          bubble: t.onboarding.gestures.rightBubble,
        };
      case "drag":
        return {
          gif: pickCharacterGif(petCharacter, "sleeping"),
          bubble: t.onboarding.gestures.dragBubble,
        };
      default:
        return {
          gif: pickCharacterGif(petCharacter, "idle"),
          bubble: t.onboarding.gestures.defaultBubble,
        };
    }
  }, [activeGesture, petCharacter, t.onboarding.gestures]);

  const doneGif = useMemo(
    () => pickCharacterGif(petCharacter, "celebrate"),
    [petCharacter],
  );

  const selectedCharacterName = useMemo(() => {
    if (petCharacter === "xiaojimao") {
      return t.onboarding.partner.characters.xiaojimaoName;
    }
    if (petCharacter === "duo") {
      return t.onboarding.partner.characters.duoName;
    }
    return t.onboarding.partner.characters.xiaobaiName;
  }, [petCharacter, t.onboarding.partner.characters]);

  const totalSteps = ONBOARDING_STEP_KEYS.length;
  const isLastStep = step === totalSteps - 1;

  return (
    <section
      className="onboarding"
      aria-label={t.onboarding.ariaLabel}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        if (event.key === "ArrowRight" && step < totalSteps - 1) {
          setStep((prev) => Math.min(totalSteps - 1, prev + 1));
        } else if (event.key === "ArrowLeft" && step > 0) {
          setStep((prev) => Math.max(0, prev - 1));
        }
      }}
    >
      <header className="onboarding__topbar">
        <span className="onboarding__step-counter">
          <Sparkles size={12} aria-hidden="true" />
          {t.onboarding.stepBadge(step + 1, totalSteps)}
        </span>
        <div className="onboarding__topbar-right">
          <button
            type="button"
            className="onboarding__lang-toggle"
            onClick={() =>
              switchLocale(currentLocale === "zh-CN" ? "en" : "zh-CN")
            }
          >
            {currentLocale === "zh-CN" ? "EN" : "中文"}
          </button>
          {!isLastStep && (
            <button
              type="button"
              className="onboarding__skip"
              onClick={onFinish}
            >
              {t.onboarding.skip}
            </button>
          )}
        </div>
      </header>

      <nav className="onboarding__stepper" aria-label={t.onboarding.ariaLabel}>
        {ONBOARDING_STEP_KEYS.map((key, index) => {
          const pillClass = [
            "onboarding__step-pill",
            index < step ? "onboarding__step-pill--done" : "",
            index === step ? "onboarding__step-pill--active" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={key}
              type="button"
              className={pillClass}
              aria-current={index === step ? "step" : undefined}
              onClick={() => setStep(index)}
            >
              <span className="onboarding__step-bar" aria-hidden="true" />
              <span>{t.onboarding.steps[key]}</span>
            </button>
          );
        })}
      </nav>

      <div className="onboarding__body">
        {step === 0 && (
          <>
            <div className="onboarding__hero">
              <span className="onboarding__badge">
                {t.onboarding.partner.badge}
              </span>
              <h2>{t.onboarding.partner.title}</h2>
              <p>{t.onboarding.partner.subtitle}</p>
            </div>
            <span className="onboarding__section-label">
              {t.onboarding.partner.chooseLabel}
            </span>
            <div className="onboarding__char-grid" role="radiogroup" aria-label={t.onboarding.partner.chooseLabel}>
              {characterCards.map((card) => {
                const active = petCharacter === card.id;
                return (
                  <button
                    key={card.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`onboarding__char-card${active ? " onboarding__char-card--active" : ""}`}
                    onClick={() => selectCharacter(card.id)}
                  >
                    {active && (
                      <span className="onboarding__char-tag">
                        {t.onboarding.partner.selectedTag}
                      </span>
                    )}
                    <img
                      src={card.gif}
                      alt={card.name}
                      className="onboarding__char-avatar"
                      draggable={false}
                    />
                    <strong>{card.name}</strong>
                    <span>{card.desc}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="onboarding__hero">
              <h2>{t.onboarding.appearance.title}</h2>
              <p>{t.onboarding.appearance.subtitle}</p>
            </div>

            <div className="onboarding__option-group">
              <span className="onboarding__section-label">
                {t.onboarding.appearance.styleLabel}
              </span>
              <div className="onboarding__dual-cards">
                <button
                  type="button"
                  className={`onboarding__style-card${localAppearance === "classic" ? " onboarding__style-card--active" : ""}`}
                  onClick={() => handleAppearance("classic")}
                >
                  <strong>{t.onboarding.appearance.classicName}</strong>
                  <span>{t.onboarding.appearance.classicDesc}</span>
                </button>
                <button
                  type="button"
                  className={`onboarding__style-card${localAppearance === "liquidGlass" ? " onboarding__style-card--active" : ""}`}
                  onClick={() => handleAppearance("liquidGlass")}
                >
                  <strong>{t.onboarding.appearance.glassName}</strong>
                  <span>{t.onboarding.appearance.glassDesc}</span>
                </button>
              </div>
            </div>

            <div className="onboarding__option-group">
              <span className="onboarding__section-label">
                {t.onboarding.appearance.scaleLabel}
              </span>
              <div className="onboarding__pills">
                {(
                  [
                    [0.78, t.onboarding.appearance.scaleCompact],
                    [0.89, t.onboarding.appearance.scaleStandard],
                    [1.08, t.onboarding.appearance.scaleLarge],
                  ] as const
                ).map(([value, label]) => {
                  const active = Math.abs(localScale - value) < 0.06;
                  return (
                    <button
                      key={value}
                      type="button"
                      className={`onboarding__pill${active ? " onboarding__pill--active" : ""}`}
                      onClick={() => handleScale(value)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="onboarding__option-group">
              <span className="onboarding__section-label">
                {t.onboarding.appearance.cornerLabel}
              </span>
              <div className="onboarding__pills">
                {(
                  [
                    ["", t.onboarding.appearance.cornerCenter],
                    ["br", t.onboarding.appearance.cornerBr],
                    ["bl", t.onboarding.appearance.cornerBl],
                    ["tr", t.onboarding.appearance.cornerTr],
                  ] as const
                ).map(([corner, label]) => {
                  const active = localCorner === corner;
                  return (
                    <button
                      key={corner || "center"}
                      type="button"
                      className={`onboarding__pill${active ? " onboarding__pill--active" : ""}`}
                      onClick={() => handleCorner(corner)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="onboarding__hero">
              <h2>{t.onboarding.gestures.title}</h2>
              <p>{t.onboarding.gestures.subtitle}</p>
            </div>
            <div className="onboarding__stage" role="status" aria-live="polite">
              <img
                src={gesturePreview.gif}
                alt={selectedCharacterName}
                className="onboarding__stage-pet"
                draggable={false}
              />
              <div className="onboarding__stage-bubble">
                {gesturePreview.bubble}
              </div>
            </div>
            <div className="onboarding__gesture-grid">
              {(
                [
                  {
                    id: "click" as const,
                    icon: Hand,
                    title: t.onboarding.gestures.clickTitle,
                    desc: t.onboarding.gestures.clickDesc,
                  },
                  {
                    id: "double" as const,
                    icon: Sparkles,
                    title: t.onboarding.gestures.doubleTitle,
                    desc: t.onboarding.gestures.doubleDesc,
                  },
                  {
                    id: "right" as const,
                    icon: MessageCircleHeart,
                    title: t.onboarding.gestures.rightTitle,
                    desc: t.onboarding.gestures.rightDesc,
                  },
                  {
                    id: "drag" as const,
                    icon: Move,
                    title: t.onboarding.gestures.dragTitle,
                    desc: t.onboarding.gestures.dragDesc,
                  },
                ] as const
              ).map((item) => {
                const Icon = item.icon;
                const active = activeGesture === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`onboarding__gesture-card${active ? " onboarding__gesture-card--active" : ""}`}
                    onClick={() => setActiveGesture(item.id)}
                  >
                    <span className="onboarding__gesture-head">
                      <strong>
                        <Icon size={13} aria-hidden="true" />
                        {item.title}
                      </strong>
                      <span className="onboarding__gesture-try">
                        {t.onboarding.gestures.tryHint}
                      </span>
                    </span>
                    <span>{item.desc}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="onboarding__hero">
              <h2>{t.onboarding.features.title}</h2>
              <p>{t.onboarding.features.subtitle}</p>
            </div>
            <div className="onboarding__feature-grid">
              {(
                [
                  {
                    icon: CheckSquare,
                    title: t.onboarding.features.todoTitle,
                    desc: t.onboarding.features.todoDesc,
                  },
                  {
                    icon: Music,
                    title: t.onboarding.features.musicTitle,
                    desc: t.onboarding.features.musicDesc,
                  },
                  {
                    icon: ClipboardList,
                    title: t.onboarding.features.clipboardTitle,
                    desc: t.onboarding.features.clipboardDesc,
                  },
                  {
                    icon: MessageCircleHeart,
                    title: t.onboarding.features.chatTitle,
                    desc: t.onboarding.features.chatDesc,
                  },
                  {
                    icon: Bell,
                    title: t.onboarding.features.notifyTitle,
                    desc: t.onboarding.features.notifyDesc,
                  },
                  {
                    icon: Sparkles,
                    title: t.onboarding.features.extrasTitle,
                    desc: t.onboarding.features.extrasDesc,
                  },
                ] as const
              ).map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="onboarding__feature-item">
                    <span className="onboarding__feature-icon" aria-hidden="true">
                      <Icon size={14} />
                    </span>
                    <div className="onboarding__feature-copy">
                      <strong>{item.title}</strong>
                      <span>{item.desc}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="onboarding__hero">
              <h2>{t.onboarding.system.title}</h2>
              <p>{t.onboarding.system.subtitle}</p>
            </div>

            <div className="onboarding__card-box">
              <div className="onboarding__card-head">
                <strong>{t.onboarding.system.shortcutLabel}</strong>
              </div>
              <small className="onboarding__hint">
                {t.onboarding.system.shortcutHint}
              </small>
              <div className="onboarding__shortcut-row">
                <input
                  className="onboarding__shortcut-input"
                  value={wakeShortcut}
                  readOnly
                  onKeyDown={(event) => void recordShortcut(event)}
                  aria-label={t.onboarding.system.shortcutAria}
                />
                <button
                  type="button"
                  className="onboarding__mini-btn"
                  onClick={() => void applyShortcut(DEFAULT_WAKE_SHORTCUT)}
                >
                  {t.onboarding.system.shortcutReset}
                </button>
              </div>
              {shortcutError && (
                <small role="alert" className="onboarding__error">
                  {shortcutError}
                </small>
              )}
              {shortcutSaved && !shortcutError && (
                <small className="onboarding__ok">
                  {t.onboarding.system.shortcutSaved}
                </small>
              )}
            </div>

            <div className="onboarding__card-box">
              <div className="onboarding__card-head">
                <strong>{t.onboarding.system.startupLabel}</strong>
              </div>
              <small className="onboarding__hint">
                {t.onboarding.system.startupHint}
              </small>
              <div className="onboarding__pills">
                <button
                  type="button"
                  className={`onboarding__pill${launchAtStartup ? " onboarding__pill--active" : ""}`}
                  onClick={() => void applyLaunchAtStartup(true)}
                >
                  {t.onboarding.system.startupOn}
                </button>
                <button
                  type="button"
                  className={`onboarding__pill${!launchAtStartup ? " onboarding__pill--active" : ""}`}
                  onClick={() => void applyLaunchAtStartup(false)}
                >
                  {t.onboarding.system.startupOff}
                </button>
              </div>
            </div>

            <div className="onboarding__card-box">
              <div className="onboarding__card-head">
                <strong>{t.onboarding.system.fullscreenLabel}</strong>
              </div>
              <small className="onboarding__hint">
                {t.onboarding.system.fullscreenHint}
              </small>
              <div className="onboarding__pills">
                {(
                  [
                    ["tuck", t.onboarding.system.fullscreenTuck],
                    ["hide", t.onboarding.system.fullscreenHide],
                    ["off", t.onboarding.system.fullscreenOff],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`onboarding__pill${localFullscreenAvoid === mode ? " onboarding__pill--active" : ""}`}
                    onClick={() => handleFullscreenAvoid(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <img
              src={doneGif}
              alt={selectedCharacterName}
              className="onboarding__done-pet"
              draggable={false}
            />
            <div className="onboarding__hero onboarding__hero--center">
              <span className="onboarding__badge">
                {t.onboarding.done.badge}
              </span>
              <h2>{t.onboarding.done.title}</h2>
              <p>{t.onboarding.done.subtitle}</p>
            </div>
            <div className="onboarding__summary-grid">
              <div className="onboarding__summary-item">
                <span>{t.onboarding.done.summaryPartner}</span>
                <strong>{selectedCharacterName}</strong>
              </div>
              <div className="onboarding__summary-item">
                <span>{t.onboarding.done.summaryShortcut}</span>
                <strong>{wakeShortcut}</strong>
              </div>
              <div className="onboarding__summary-item">
                <span>{t.onboarding.done.summaryStartup}</span>
                <strong>
                  {launchAtStartup
                    ? t.onboarding.done.startupEnabled
                    : t.onboarding.done.startupDisabled}
                </strong>
              </div>
            </div>
            <p className="onboarding__reopen-note">
              {t.onboarding.done.reopenHint}
            </p>
          </>
        )}
      </div>

      {!isLastStep ? (
        <footer className="onboarding__footer">
          <button
            type="button"
            className="onboarding__ghost"
            disabled={step === 0}
            style={step === 0 ? { visibility: "hidden" } : undefined}
            onClick={() => setStep((prev) => Math.max(0, prev - 1))}
          >
            <ChevronLeft size={14} aria-hidden="true" />
            {t.onboarding.back}
          </button>
          <button
            type="button"
            className="onboarding__primary"
            onClick={() => setStep((prev) => Math.min(totalSteps - 1, prev + 1))}
          >
            {t.onboarding.next}
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </footer>
      ) : (
        <footer className="onboarding__footer onboarding__footer--end">
          {onExploreTodo && (
            <button
              type="button"
              className="onboarding__ghost"
              onClick={onExploreTodo}
            >
              {t.onboarding.done.openPanel}
            </button>
          )}
          <button
            type="button"
            className="onboarding__primary"
            onClick={onFinish}
          >
            {t.onboarding.done.startCompanion}
          </button>
        </footer>
      )}
    </section>
  );
}
