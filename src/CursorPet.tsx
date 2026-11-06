import {
  rotationFramesForState,
  usePetGifRotationConfig,
  usePetGifRotationStates,
} from "./petGifRotation";
import { usePetGifRotation } from "./usePetGifRotation";
import "./DesktopExtras.css";

// 鼠标指针皮肤：窗口本身由 Rust 每 16ms 跟随光标并保持鼠标穿透。
export default function CursorPet() {
  const gifRotationConfig = usePetGifRotationConfig();
  const gifRotationStates = usePetGifRotationStates();
  const gifSrc = usePetGifRotation(
    rotationFramesForState(gifRotationConfig, "idle", gifRotationStates),
    { intervalMs: 13_000 },
  );
  return (
    <div className="cursor-pet" aria-hidden="true">
      <img src={gifSrc} alt="" draggable={false} />
    </div>
  );
}