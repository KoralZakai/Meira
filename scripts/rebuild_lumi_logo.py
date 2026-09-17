from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


SOURCE = Path("assets/lumilogo_topleft.png")
OUTPUT = Path("assets/lumilogo_topleft_bubble.png")


def saturation_alpha(rgb: np.ndarray) -> np.ndarray:
    rgb_f = rgb.astype(np.float32)
    max_c = rgb_f.max(axis=2)
    min_c = rgb_f.min(axis=2)
    sat = np.where(max_c == 0.0, 0.0, (max_c - min_c) / max_c)

    # Softly isolate colored logo elements from the checkerboard background.
    alpha = np.clip((sat - 0.015) / 0.045, 0.0, 1.0)
    return (alpha * 255.0).astype(np.uint8)


def main() -> None:
    src = Image.open(SOURCE).convert("RGB")
    rgb = np.array(src)

    alpha = saturation_alpha(rgb)
    rgba = np.dstack([rgb, alpha])
    out = Image.fromarray(rgba, mode="RGBA")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    out.save(OUTPUT, format="PNG")

    print(f"Saved: {OUTPUT}")
    print(f"Image size: {out.size}")
    print("Preserved original bubbly 'Lumi', clock icon, and 'AI' label.")


if __name__ == "__main__":
    main()
