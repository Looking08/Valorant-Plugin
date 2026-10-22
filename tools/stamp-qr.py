#!/usr/bin/env python3
"""
给二维码图片加一圈白边 + 底部时间戳。

为什么需要：同一个聊天窗口里连着贴好几张码，人根本分不清哪张是新的，
扫到旧的就显示「已失效」，白折腾一轮。有时间戳就一眼能看出来。

用法：
  python3 tools/stamp-qr.py 输入.png 输出.png "生成 00:26:31 · 2 分钟内有效"
"""
import sys
import cv2
import numpy as np

FONT = cv2.FONT_HERSHEY_SIMPLEX


def stamp(src: str, dst: str, label: str, margin: int = 48, bar: int = 54) -> None:
    img = cv2.imread(src)
    if img is None:
        raise SystemExit(f"读不到图片：{src}")

    # 统一放大到至少 480px 见方，手机上更好扫
    h, w = img.shape[:2]
    side = max(h, w)
    if side < 480:
        scale = 480 / side
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_NEAREST)
        h, w = img.shape[:2]

    canvas = np.full((h + margin * 2 + bar, w + margin * 2, 3), 255, dtype=np.uint8)
    canvas[margin:margin + h, margin:margin + w] = img

    size = 0.68
    thick = 2
    (tw, th), _ = cv2.getTextSize(label, FONT, size, thick)
    x = max(8, (canvas.shape[1] - tw) // 2)
    y = margin + h + 34
    cv2.putText(canvas, label, (x, y), FONT, size, (40, 40, 40), thick, cv2.LINE_AA)

    cv2.imwrite(dst, canvas)
    print(f"{dst}  {canvas.shape[1]}x{canvas.shape[0]}")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    stamp(sys.argv[1], sys.argv[2], sys.argv[3])
