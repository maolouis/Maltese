"""把方形图标源图切成圆角图，供 `pnpm tauri icon` 使用。

用法（需要 Pillow：python -m pip install pillow）：

    python scripts/make-rounded-icon.py --src icon.png --out build/icon-rounded-1024.png

    pnpm tauri icon build/icon-rounded-1024.png

圆角外的区域是透明的，圆角半径按边长的比例给（默认 22%，接近 Windows / iOS 应用图标的观感）。
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw

SS = 4  # 超采样倍数，保证圆角边缘平滑


def main() -> None:
    parser = argparse.ArgumentParser(description="生成圆角应用图标")
    parser.add_argument("--src", required=True, help="方形源图路径")
    parser.add_argument("--out", required=True, help="输出 PNG 路径")
    parser.add_argument("--size", type=int, default=1024, help="输出边长，默认 1024")
    parser.add_argument(
        "--radius-ratio",
        type=float,
        default=0.22,
        help="圆角半径占边长的比例，默认 0.22",
    )
    args = parser.parse_args()

    img = Image.open(args.src).convert("RGB")
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side)).resize(
        (args.size, args.size), Image.LANCZOS
    )

    big = args.size * SS
    mask_big = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask_big).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=int(big * args.radius_ratio), fill=255
    )
    mask = mask_big.resize((args.size, args.size), Image.LANCZOS)

    out = img.convert("RGBA")
    out.putalpha(mask)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.save(out_path, "PNG", optimize=True)

    corner = out.getpixel((0, 0))[3]
    print(f"wrote {out_path} ({args.size}x{args.size}) 左上角 alpha={corner}")


if __name__ == "__main__":
    main()
