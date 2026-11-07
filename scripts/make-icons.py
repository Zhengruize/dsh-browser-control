"""Generate the extension icon set (blue rounded tile with browser window + cursor)."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT, exist_ok=True)
SCALE = 8
BASE = 128


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make(size):
    s = BASE * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(s * 0.03)
    rounded_rect(d, (pad, pad, s - pad, s - pad), int(s * 0.24), (37, 99, 235, 255))

    # browser window
    wx0, wy0 = int(s * 0.17), int(s * 0.20)
    wx1, wy1 = int(s * 0.83), int(s * 0.74)
    r = int(s * 0.10)
    d.rounded_rectangle((wx0, wy0, wx1, wy1), radius=r, outline=(255, 255, 255, 255), width=int(s * 0.055))
    # title bar line
    d.line((wx0 + int(s * 0.02), wy0 + int(s * 0.15), wx1 - int(s * 0.02), wy0 + int(s * 0.15)), fill=(255, 255, 255, 255), width=int(s * 0.035))
    # two window dots
    cy = wy0 + int(s * 0.075)
    for i, cx in enumerate((wx0 + int(s * 0.11), wx0 + int(s * 0.24))):
        rr = int(s * 0.022)
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=(255, 255, 255, 255))

    # cursor arrow (bottom-right)
    pts = [
        (int(s * 0.56), int(s * 0.47)),
        (int(s * 0.83), int(s * 0.62)),
        (int(s * 0.69), int(s * 0.66)),
        (int(s * 0.76), int(s * 0.82)),
        (int(s * 0.67), int(s * 0.86)),
        (int(s * 0.60), int(s * 0.70)),
        (int(s * 0.50), int(s * 0.80)),
    ]
    d.polygon(pts, fill=(255, 255, 255, 255), outline=(37, 99, 235, 255))

    img = img.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, f"icon{size}.png"), "PNG")
    print("wrote", os.path.join(OUT, f"icon{size}.png"))


for size in (16, 32, 48, 128):
    make(size)
