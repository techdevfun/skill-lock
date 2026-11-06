#!/usr/bin/env python3
"""Render demo/transcript.txt as a terminal-typing GIF (PIL, DejaVuSansMono).
The transcript is generated from real CLI runs (see scripts/record-demo.sh);
this script only renders it, never edits the content."""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1080, 620
BG = (18, 18, 24)
FG = (220, 220, 220)
DIM = (150, 150, 160)
GREEN = (120, 220, 130)
YELLOW = (235, 200, 100)
RED = (240, 110, 110)
CYAN = (120, 200, 230)

font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 13)
bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 13)
LINE_H = 18

lines = open("demo/transcript.txt").read().splitlines()

def color_for(line: str):
    if line.startswith("$"):
        return GREEN
    if line.startswith("CLEAN"):
        return GREEN
    if line.startswith("DRIFT"):
        return RED
    if line.startswith("GHOST"):
        return RED
    if line.startswith("== CHANGED"):
        return YELLOW
    if line.startswith("@@"):
        return CYAN
    if line.startswith("+") and not line.startswith("++"):
        return GREEN
    if line.startswith("-") and not line.startswith("--"):
        return RED
    if "MISSING" in line:
        return RED
    if "EXISTS" in line:
        return GREEN
    if line.startswith("exit:"):
        return RED
    if "re-baselined" in line:
        return GREEN
    if line.startswith("note:"):
        return YELLOW
    return FG

frames = []
canvas: list[tuple[str, tuple]] = []

# Title card (1.5s): what the demo shows
title = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(title)
d.text((14, 150), "skill-lock — did the skill change since you approved it?", font=bold, fill=GREEN)
d.text((14, 200), "1. init pins every skill file by SHA-256", font=font, fill=FG)
d.text((14, 230), "2. verify catches a one-line edit — exit 1", font=font, fill=FG)
d.text((14, 260), "3. diff shows the exact line; approve re-baselines", font=font, fill=FG)
d.text((14, 290), "4. check-refs finds the package that does not exist", font=font, fill=FG)
d.text((14, 360), "zero-dep CLI · lockfile holds hashes, never contents", font=font, fill=DIM)
for _ in range(25):
    frames.append(title.copy())

def render(canvas_tmp):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    y = 14
    for text, color in canvas_tmp:
        f = bold if text.startswith(("$", "CLEAN", "DRIFT", "GHOST", "== CHANGED")) else font
        d.text((14, y), text, font=f, fill=color)
        y += LINE_H
        if y > H - 30:
            break
    d.rectangle([14, H - 24, 22, H - 12], fill=GREEN)
    return img

# Lines per screen: the transcript (61 lines) is longer than one screen,
# so clear like a real terminal instead of silently dropping the tail —
# the check-refs payoff must stay visible.
MAX_LINES = (H - 30 - 14) // LINE_H

for line in lines:
    if len(canvas) >= MAX_LINES:
        canvas = []
        for _ in range(4):
            frames.append(render(canvas))
    color = color_for(line)
    step = max(1, len(line) // 5)
    for i in range(0, len(line) + 1, step):
        frames.append(render(canvas + [(line[:i], color)]))
    canvas.append((line, color))
    if line.startswith(("CLEAN", "DRIFT", "GHOST", "exit:")) or "re-baselined" in line:
        for _ in range(8):
            frames.append(frames[-1].copy())

for _ in range(15):
    frames.append(frames[-1].copy())

frames[0].save(
    "demo/skill-lock-demo.gif",
    save_all=True,
    append_images=frames[1:],
    duration=60,
    loop=0,
)
print(f"frames={len(frames)} size={os.path.getsize('demo/skill-lock-demo.gif')} duration~{len(frames)*60/1000:.1f}s")
