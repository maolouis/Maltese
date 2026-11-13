import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { petAssetUrl } from "./petAssetBase";
import { invoke } from "@tauri-apps/api/core";
import { resolvePetGif } from "./petAssets";
import { loadWakeShortcut, saveWakeShortcut } from "./wakeShortcut";

const ONBOARDING_DONE_KEY = "maltese-onboarding-done";

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

const STEPS = ["欢迎", "显示 / 隐藏", "开机自启", "完成"] as const;

export function OnboardingPanel({ onFinish }: { onFinish: () => void }) {
  const [step, setStep] = useState(0);
  const [petSrc] = useState(petAssetUrl("/assets/pets/rest.gif"));
  const [donePetSrc] = useState(() => resolvePetGif("celebrate"));

  // 快捷键步骤状态
  const [wakeShortcut, setWakeShortcut] = useState(loadWakeShortcut);
  const [shortcutError, setShortcutError] = useState("");
  const [shortcutSaved, setShortcutSaved] = useState(false);

  // 开机自启步骤状态
  const [launchAtStartup, setLaunchAtStartup] = useState(false);

  useEffect(() => {
    if (step !== 2) {
      return;
    }
    void invoke<boolean>("get_launch_at_startup")
      .then(setLaunchAtStartup)
      .catch(() => setLaunchAtStartup(false));
  }, [step]);

  const recordShortcut = useCallback(async (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
      return;
    }
    const modifiers = [
      event.ctrlKey && "Ctrl",
      event.altKey && "Alt",
      event.shiftKey && "Shift",
      event.metaKey && "Win",
    ].filter(Boolean) as string[];
    if (!modifiers.length) {
      setShortcutError("请至少按住 Ctrl、Alt、Shift 或 Win 之一。");
      return;
    }
    const key = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
    const next = [...modifiers, key].join("+");
    try {
      const registered = await invoke<string>("set_wake_shortcut", { shortcut: next });
      setWakeShortcut(registered);
      saveWakeShortcut(registered);
      setShortcutError("");
      setShortcutSaved(true);
    } catch (error) {
      setShortcutError(String(error));
      setShortcutSaved(false);
    }
  }, []);

  const applyLaunchAtStartup = useCallback(async (enabled: boolean) => {
    try {
      await invoke("set_launch_at_startup", { enabled });
      setLaunchAtStartup(enabled);
    } catch {
      setLaunchAtStartup(false);
    }
  }, []);

  return (
    <section className="onboarding" aria-label="Maltese 首次运行向导">
      <div className="onboarding__progress" aria-hidden="true">
        {STEPS.map((label, index) => (
          <span
            key={label}
            className={index <= step ? "onboarding__dot onboarding__dot--active" : "onboarding__dot"}
          />
        ))}
      </div>

      {step === 0 && (
        <div className="onboarding__step">
          <img src={petSrc} alt="睡觉的线条小狗" className="onboarding__pet" />
          <h2>你好，我是线条小狗</h2>
          <p>
            我会待在你的桌面上，陪你看待办、听音乐、收消息。
            花一分钟完成初始设置，之后就可以随时用快捷键叫我出来，或让我先躲起来。
          </p>
          <div className="onboarding__actions">
            <button type="button" className="onboarding__primary" onClick={() => setStep(1)}>
              开始设置
            </button>
            <button type="button" className="onboarding__ghost" onClick={onFinish}>
              跳过向导
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="onboarding__step">
          <h2>设置显示 / 隐藏桌宠的快捷键</h2>
          <p>
            默认是 <strong>Ctrl+Alt+Shift+M</strong>。点击下面的输入框后直接按下你想要的组合键；
            如果和其他软件冲突，会提示占用原因，可以换一个。
          </p>
          <input
            className="onboarding__shortcut"
            value={wakeShortcut}
            readOnly
            onKeyDown={(event) => void recordShortcut(event)}
            aria-label="显示或隐藏桌宠的快捷键"
          />
          {shortcutError && <small role="alert" className="onboarding__error">{shortcutError}</small>}
          {shortcutSaved && !shortcutError && <small className="onboarding__ok">快捷键已生效</small>}
          <div className="onboarding__actions">
            <button type="button" className="onboarding__ghost" onClick={() => setStep(0)}>
              上一步
            </button>
            <button type="button" className="onboarding__primary" onClick={() => setStep(2)}>
              下一步
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="onboarding__step">
          <h2>开机时自动启动</h2>
          <p>开启后，每次登录 Windows 我都会悄悄出现在桌面上。</p>
          <div className="onboarding__actions">
            <button
              type="button"
              className={launchAtStartup ? "onboarding__primary" : "onboarding__ghost"}
              onClick={() => void applyLaunchAtStartup(true)}
            >
              {launchAtStartup ? "已开启开机自启" : "开启开机自启"}
            </button>
            <button
              type="button"
              className="onboarding__ghost"
              onClick={() => void applyLaunchAtStartup(false)}
            >
              不用了
            </button>
          </div>
          <div className="onboarding__actions">
            <button type="button" className="onboarding__ghost" onClick={() => setStep(1)}>
              上一步
            </button>
            <button type="button" className="onboarding__primary" onClick={() => setStep(3)}>
              下一步
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="onboarding__step">
          <img src={donePetSrc} alt="庆祝的线条小狗" className="onboarding__pet" />
          <h2>设置完成</h2>
          <p>
            单击摸摸头、双击让我庆祝、右键把我抱起来。鼠标悬停会出现互动气泡，
            快捷面板里可以放你常用的软件和脚本，随时按 {wakeShortcut} 叫我或收起我。
          </p>
          <div className="onboarding__actions">
            <button type="button" className="onboarding__primary" onClick={onFinish}>
              开始陪我玩
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
