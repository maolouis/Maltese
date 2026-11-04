import "./DesktopExtras.css";

// 鼠标指针皮肤：窗口本身由 Rust 每 16ms 跟随光标并保持鼠标穿透。
export default function CursorPet() {
  return (
    <div className="cursor-pet" aria-hidden="true">
      <img src="/assets/pets/idle/2.gif" alt="" draggable={false} />
    </div>
  );
}