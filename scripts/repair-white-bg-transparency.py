#!/usr/bin/env python3
"""修复被旧版白底抠图脚本误抠成透明的桌宠 GIF。

背景：旧脚本（.tmp-build/fix-white-bg.py）从边框做近白色洪水填充去白底，
但线条轮廓有缝隙，洪水填充漏进狗身，把白色身体填充也一并抠成透明，
只剩深色轮廓。本脚本从备份原图（white-bg-backup）重新抠底。

算法（2026-11-19 第 3 版）：

1. 近白色像素分两类：与边框连通的**外部背景** → 透明；被轮廓围住的**白色身体** → 保留。
2. 轮廓屏障做 4 像素膨胀，封住抗锯齿缝隙。贴纸里两只白狗相邻时轮廓会断开，2px 挡不住，
   白身会和外部背景连成一片被整块抠掉（`happy/p15-9` 早期帧就是这样丢的）。
3. **白环内收**（v3）：洪水填充后把背景往外收 3 像素、但不越过屏障，压掉白底边缘残留的
   「光晕」，同时不会重新打穿轮廓缝隙。
4. **调色板透明索引**：给每帧量化出 255 色，**预留 255 号索引专门做透明**，保存时 `transparency=255`。
5. 保留原 GIF 的帧数、时长、循环、disposal 与画布尺寸（手写 GIF89a 容器，不做帧合并）。

用法（默认路径对应本仓库）：

    python scripts/repair-white-bg-transparency.py \
        --backup .tmp-build/white-bg-backup \
        --assets assets/pets

只处理「备份里有、当前资产目录里也存在」的 GIF；其它素材不动。
原始备份不会被覆盖。
"""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageSequence

WHITE_MIN = 228
WHITE_SPREAD = 26
# 屏障要够厚：贴纸里两只白狗相邻时轮廓会在抗锯齿处断开，2px 屏障挡不住，白身会和外部背景连成一片
BARRIER_DILATE = 4
# 洪水填充后把「外部背景」再往外收（内收但不越过屏障），压掉白底边缘残留的白环
BARRIER_ERODE = 3
# 预留的透明调色板索引（0–254 给画面颜色）
TRANSPARENT_INDEX = 255

# 这几张不是白底（绿底 / 薄荷底 / 暗底），白底洪水填充不适用；HEAD 版本本身已经
# 四角透明、身体完整，直接保持 HEAD（不纳入本次重跑，避免把背景做成硬边或误伤身体）。
# 详见 docs/qa-recut-video-2026-11-19.md A3 与 docs/pet-characters.md。
ROLLED_BACK_FILES = [
    "chars/shared/pet/p11-7.gif",
    "chars/xiaobai/play/p22-7.gif",
    "chars/xiaojimao/idle/p18-2.gif",
    "chars/xiaojimao/sleep/sp-xxgold-2-8.gif",
    "stickers/weibo/happy/p15-9.gif",
    "stickers/weibo/happy/p16-8.gif",
]
# 彩色背景（少数素材是绿底/彩色底）：取边框主色，按通道容差判定背景
BORDER_TOLERANCE = 14


def _dilate(mask: np.ndarray) -> np.ndarray:
    """4 邻接膨胀（不 wrap，避免图像对边被当成邻居）。"""
    grown = mask.copy()
    grown[1:, :] |= mask[:-1, :]
    grown[:-1, :] |= mask[1:, :]
    grown[:, 1:] |= mask[:, :-1]
    grown[:, :-1] |= mask[:, 1:]
    return grown


def _dilate8(mask: np.ndarray) -> np.ndarray:
    """8 邻接膨胀（不 wrap）；用于边缘回收。"""
    grown = mask.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            shifted = np.zeros_like(mask)
            ys = slice(max(0, dy), mask.shape[0] + min(0, dy))
            xs = slice(max(0, dx), mask.shape[1] + min(0, dx))
            ys_src = slice(max(0, -dy), mask.shape[0] + min(0, -dy))
            xs_src = slice(max(0, -dx), mask.shape[1] + min(0, -dx))
            shifted[ys, xs] = mask[ys_src, xs_src]
            grown |= shifted
    return grown


def background_mask(rgb: np.ndarray, dilate: int = BARRIER_DILATE) -> tuple[np.ndarray, np.ndarray]:
    """外部白背景：边框连通的近白像素，洪水填充被膨胀后的轮廓挡住。返回 (背景, 屏障)。"""
    white = (rgb.min(axis=-1) > WHITE_MIN) & (
        (rgb.max(axis=-1) - rgb.min(axis=-1)) < WHITE_SPREAD
    )
    barrier = ~white
    for _ in range(dilate):
        barrier = _dilate(barrier)
    exterior = np.zeros_like(white)
    exterior[0, :] = white[0, :]
    exterior[-1, :] = white[-1, :]
    exterior[:, 0] = white[:, 0]
    exterior[:, -1] = white[:, -1]
    while True:
        grown = _dilate(exterior) & white & ~barrier
        if (grown == exterior).all():
            break
        exterior = grown
    return exterior, barrier


def shrink_exterior(exterior: np.ndarray, barrier: np.ndarray, rounds: int = BARRIER_ERODE) -> np.ndarray:
    """把背景往外收 `rounds` 像素，压掉残留白环；被屏障挡住，不会重新打穿轮廓缝隙。"""
    out = exterior.copy()
    for _ in range(rounds):
        out = _dilate(out) & ~barrier
    return out

def remove_white_bg(frame: Image.Image) -> Image.Image:
    """一帧 RGBA → 去掉白底，保留被轮廓包住的身体填色；再把背景外沿内收几像素压白环。"""
    rgba = np.asarray(frame.convert("RGBA")).copy()
    rgb = rgba[..., :3].astype(np.int16)
    exterior, barrier = background_mask(rgb)
    exterior = shrink_exterior(exterior, barrier)
    rgba[..., 3] = np.where(exterior, 0, rgba[..., 3])
    return Image.fromarray(rgba, "RGBA")


def _parse_single_frame_gif(data: bytes) -> dict:
    """解析 Pillow 写出的单帧 GIF：返回调色板、LZW 数据块与透明索引。

    为什么要手写多帧容器：Pillow 12 的 GIF 写入器会把「量化后完全相同」的相邻帧合并
    （并把时长加到前一帧），还会把 duration 列表写成同一值——实测会把 14 帧的
    `xiaojimao/angry/p18-6.gif` 压成 13 帧、把所有帧时长写成 1100ms。
    这里只借用 Pillow 的量化 + LZW 压缩，然后自己拼 GIF89a 容器，保证
    **帧数 / 时长 / 画布 / 逐帧调色板** 与备份原图一致。
    """
    if data[:6] not in (b"GIF89a", b"GIF87a"):
        raise ValueError("not a gif")
    width = int.from_bytes(data[6:8], "little")
    height = int.from_bytes(data[8:10], "little")
    packed = data[10]
    pos = 13
    palette = b""
    palette_bits = 0
    if packed & 0x80:
        palette_bits = (packed & 0x07) + 1
        size = 3 * (2 ** palette_bits)
        palette = data[pos : pos + size]
        pos += size

    transparency = None
    # 跳过扩展块，直到图像分隔符 0x2C
    while pos < len(data):
        block = data[pos]
        if block == 0x21:  # extension
            label = data[pos + 1]
            pos += 2
            sub = []
            while pos < len(data) and data[pos] != 0:
                length = data[pos]
                sub.append(data[pos + 1 : pos + 1 + length])
                pos += 1 + length
            pos += 1  # block terminator
            if label == 0xF9 and sub:
                gce = sub[0]
                if gce[0] & 0x01:
                    transparency = gce[3]
        elif block == 0x2C:  # image descriptor
            pos += 1
            left = int.from_bytes(data[pos : pos + 2], "little")
            top = int.from_bytes(data[pos + 2 : pos + 4], "little")
            fw = int.from_bytes(data[pos + 4 : pos + 6], "little")
            fh = int.from_bytes(data[pos + 6 : pos + 8], "little")
            lpacked = data[pos + 8]
            pos += 9
            if lpacked & 0x80:
                bits = (lpacked & 0x07) + 1
                size = 3 * (2 ** bits)
                palette = data[pos : pos + size]
                palette_bits = bits
                pos += size
            min_code_size = data[pos]
            pos += 1
            start = pos
            while pos < len(data) and data[pos] != 0:
                pos += 1 + data[pos]
            lzw = data[start:pos]
            pos += 1
            return {
                "width": width,
                "height": height,
                "left": left,
                "top": top,
                "frame_width": fw,
                "frame_height": fh,
                "palette": palette,
                "palette_bits": palette_bits,
                "min_code_size": min_code_size,
                "interlaced": bool(lpacked & 0x40),
                "lzw": lzw,
                "transparency": transparency,
            }
        else:
            break
    raise ValueError("image descriptor not found")


def to_paletted(rgba: Image.Image) -> Image.Image:
    """RGBA → P：量化 255 色，把 255 号索引留给透明。

    必须显式预留索引：如果直接让 Pillow 从 RGBA 存 GIF，它会自己挑一个「透明色索引」——
    而那个索引往往同时被白色身体占用，身体就又变透明了（v1 的老问题）。
    """
    arr = np.asarray(rgba)
    alpha = arr[..., 3]
    rgb = arr[..., :3]
    opaque = alpha > 0
    base = Image.fromarray(rgb, "RGB")
    if not opaque.any():
        index = np.full(alpha.shape, TRANSPARENT_INDEX, dtype=np.uint8)
        out = Image.fromarray(index, "P")
        out.putpalette([0, 0, 0] * 256)
        return out
    quantized = base.quantize(
        colors=TRANSPARENT_INDEX, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    index = np.asarray(quantized).astype(np.uint16).copy()
    index[~opaque] = TRANSPARENT_INDEX
    out = Image.fromarray(index.astype(np.uint8), "P")
    palette = list(quantized.getpalette() or [])
    out.putpalette((palette + [0, 0, 0] * 256)[: 256 * 3])
    return out


def _frame_gif_bytes(rgba: Image.Image) -> dict:
    """把一帧 Paletted 图像交给 Pillow 做 LZW 压缩，只借用压缩结果。"""
    paletted = to_paletted(rgba)
    buf = io.BytesIO()
    # 让 Pillow 自己处理调色板重排，但把透明索引固定为预留的 255：
    # 它会把透明索引一起重映射，解析出来的 transparency 就是最终索引。
    paletted.save(buf, format="GIF", transparency=TRANSPARENT_INDEX)
    return _parse_single_frame_gif(buf.getvalue())


def write_gif(
    dst: Path,
    frames: list[Image.Image],
    durations: list[int],
    loop: int,
) -> None:
    """手写 GIF89a：逐帧调色板 + 透明索引 + 精确时长，不做任何帧合并。"""
    parsed = [_frame_gif_bytes(f) for f in frames]
    width, height = frames[0].size
    out = bytearray(b"GIF89a")
    out += width.to_bytes(2, "little") + height.to_bytes(2, "little")
    out += bytes([0x70, 0x00, 0x00])  # 无全局调色板，背景色 0
    if loop is not None:
        out += b"\x21\xff\x0bNETSCAPE2.0\x03\x01" + int(loop).to_bytes(2, "little") + b"\x00"
    for index, (frame, duration) in enumerate(zip(frames, durations)):
        info = parsed[index]
        delay = max(1, int(round(duration / 10)))  # GIF 单位 1/100 秒
        # 透明索引取「单帧 GIF 解析出来的最终索引」：Pillow 保存时可能重排调色板。
        transparency = info["transparency"]
        transparent_flag = 0x01 if transparency is not None else 0x00
        disposal = 2
        out += b"\x21\xf9\x04"
        out += bytes([(disposal << 2) | transparent_flag])
        out += delay.to_bytes(2, "little")
        out += bytes([transparency if transparency is not None else 0])
        out += b"\x00"
        bits = max(1, info["palette_bits"])
        palette = info["palette"]
        expected = 3 * (2 ** bits)
        palette = palette[:expected].ljust(expected, b"\x00")
        left = info["left"]
        top = info["top"]
        fw = info["frame_width"]
        fh = info["frame_height"]
        out += b"\x2c"
        out += left.to_bytes(2, "little") + top.to_bytes(2, "little")
        out += fw.to_bytes(2, "little") + fh.to_bytes(2, "little")
        out += bytes([0x80 | (0x40 if info.get("interlaced") else 0x00) | (bits - 1)])
        out += palette
        out += bytes([info["min_code_size"]])
        out += info["lzw"]
        out += b"\x00"
    out += b"\x3b"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(bytes(out))


def process(src: Path, dst: Path, rel: str) -> dict:
    with Image.open(src) as im:
        frames = [f.copy() for f in ImageSequence.Iterator(im)]
        info = dict(im.info)
        size = im.size
        durations = [f.info.get("duration", info.get("duration", 100)) for f in frames]
        loop = info.get("loop", 0)

    rgba_frames = [remove_white_bg(f) for f in frames]
    write_gif(dst, rgba_frames, durations, loop)
    return {
        "path": rel,
        "frames": len(frames),
        "size": list(size),
        "durations": durations,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backup", default=".tmp-build/white-bg-backup")
    ap.add_argument("--assets", default="assets/pets")
    ap.add_argument("--report", default="work/white-bg-repair-report.json")
    ap.add_argument(
        "--exclude",
        default=",".join(ROLLED_BACK_FILES),
        help="逗号分隔的相对路径：这些素材保持 HEAD 版本（彩色背景/暗底，白底算法不适用）",
    )
    args = ap.parse_args()

    backup = Path(args.backup)
    assets = Path(args.assets)
    excludes = {item.strip() for item in args.exclude.split(",") if item.strip()}
    rows = []
    skipped = []
    for src in sorted(backup.rglob("*.gif")):
        rel = src.relative_to(backup).as_posix()
        cur = assets / rel
        if not cur.exists():
            continue
        if rel in excludes:
            skipped.append(rel)
            continue
        rows.append(process(src, cur, rel))

    report = Path(args.report)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"processed {len(rows)} GIF(s); skipped {len(skipped)} (rolled back to HEAD); report: {report}")
    for rel in skipped:
        print(f"  skip {rel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())