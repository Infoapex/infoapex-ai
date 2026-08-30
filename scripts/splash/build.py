# -*- coding: utf-8 -*-
"""Regenerate the InfoApex AI splash artwork (SVG + PNG).

Design-time tool only; nothing in the shipped bundle depends on it.

Prerequisites
    Python 3.10+ with `fonttools`   ->  pip install fonttools
    Chrome or Edge (used as the deterministic rasterizer)

Fonts (SIL OFL) are fetched once into scripts/splash/fonts/, which is
git-ignored. They are never redistributed as font files: the generator
converts every glyph to an outline path, so the SVG carries only vector
geometry and depends on no installed font at view time.

    python scripts/splash/build.py            # svg + png
    python scripts/splash/build.py --svg-only
"""
import os
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "docs", "assets")
FONTS = os.path.join(HERE, "fonts")

GF = "https://raw.githubusercontent.com/google/fonts/main"
FONT_FILES = {
    "Poppins-Bold.ttf": f"{GF}/ofl/poppins/Poppins-Bold.ttf",
    "Poppins-SemiBold.ttf": f"{GF}/ofl/poppins/Poppins-SemiBold.ttf",
    "Poppins-Medium.ttf": f"{GF}/ofl/poppins/Poppins-Medium.ttf",
    "Poppins-Regular.ttf": f"{GF}/ofl/poppins/Poppins-Regular.ttf",
    "Inter[opsz,wght].ttf": f"{GF}/ofl/inter/Inter%5Bopsz,wght%5D.ttf",
    "JetBrainsMono[wght].ttf": f"{GF}/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf",
}

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

SRC = os.path.join(OUT, "src")

# Logo assets are derived from the supplied light-painted renders: the dark
# plate is converted to alpha so they composite additively (see raster_logo.py).
# This must run before the infographic, which embeds the keyed results.
RASTERS = [("infoapex-mark-source.png", "infoapex-logo"),
           ("infoapex-lockup-source.png", "infoapex-logo-lockup")]

#          module              builder  output stem                       w     h    alpha
TARGETS = [("splash_architecture", "build", "infoapex-ai-splash-architecture", 1672, 941, False)]


def ensure_fonts():
    os.makedirs(FONTS, exist_ok=True)
    for name, url in FONT_FILES.items():
        dst = os.path.join(FONTS, name)
        if os.path.exists(dst):
            continue
        print(f"  fetching {name}")
        with urllib.request.urlopen(url, timeout=60) as r:
            data = r.read()
        with open(dst, "wb") as fh:
            fh.write(data)


def find_browser():
    for p in BROWSERS:
        if os.path.exists(p):
            return p
    return None


def rasterize(svg_path, png_path, w, h, alpha=False):
    """Render the SVG through a headless Chromium at exactly w x h."""
    browser = find_browser()
    if not browser:
        print("  ! no Chrome/Edge found - skipping PNG")
        return False
    shell = os.path.join(HERE, "_shell.html")
    bg = "transparent" if alpha else "#000"
    with open(shell, "w", encoding="utf-8") as fh:
        fh.write('<!doctype html><meta charset="utf-8">'
                 f'<style>html,body{{margin:0;padding:0;background:{bg}}}'
                 f'img{{display:block;width:{w}px;height:{h}px}}</style>'
                 f'<img src="file:///{svg_path.replace(os.sep, "/")}">')
    if os.path.exists(png_path):
        os.remove(png_path)
    cmd = [browser, "--headless", "--disable-gpu", "--hide-scrollbars",
           "--force-device-scale-factor=1", f"--window-size={w},{h}"]
    if alpha:
        cmd.append("--default-background-color=00000000")
    cmd += [f"--screenshot={png_path}", shell]
    subprocess.run(cmd, capture_output=True, timeout=180)
    os.remove(shell)
    if not os.path.exists(png_path):
        print("  ! rasterization produced no file")
        return False
    try:
        from PIL import Image
        im = Image.open(png_path)
        im = im.convert("RGBA" if alpha else "RGB")
        assert im.size == (w, h), f"expected {(w, h)}, got {im.size}"
        if alpha:
            corners = [im.getpixel(p)[3] for p in
                       ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
            assert max(corners) == 0, f"corners not transparent: {corners}"
        im.save(png_path, optimize=True)
        print(f"  png {im.size[0]}x{im.size[1]} {im.mode}  "
              f"{os.path.getsize(png_path) / 1024:.0f} KB")
    except ImportError:
        print("  png written (install Pillow to verify size and optimize)")
    return True


def key_rasters():
    """Key the supplied logo renders to transparent RGBA, plus an SVG wrapper."""
    import base64
    from raster_logo import key_glow, trim
    from PIL import Image

    for src_name, stem in RASTERS:
        src = os.path.join(SRC, src_name)
        if not os.path.exists(src):
            print(f"  ! missing {os.path.relpath(src, ROOT)} - keeping existing asset")
            continue
        out, plate, st = key_glow(Image.open(src), plate="fit")
        out = trim(out)
        png = os.path.join(OUT, stem + ".png")
        out.save(png, optimize=True)
        with open(png, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("ascii")
        w, h = out.size
        with open(os.path.join(OUT, stem + ".svg"), "w", encoding="utf-8") as fh:
            fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" '
                     f'height="{h}" viewBox="0 0 {w} {h}">\n'
                     f'<title>InfoApex</title>\n'
                     f'<image width="{w}" height="{h}" '
                     f'href="data:image/png;base64,{b64}"/>\n</svg>\n')
        print(f"  {stem}: {w}x{h} RGBA, {st['transparent'] * 100:.0f}% transparent"
              f"  ({os.path.getsize(png) / 1024:.0f} KB)")


def main():
    svg_only = "--svg-only" in sys.argv
    print("fonts:")
    ensure_fonts()
    sys.path.insert(0, HERE)
    os.makedirs(OUT, exist_ok=True)
    print("logo (keyed from source renders):")
    key_rasters()
    failed = False
    for module, builder, stem, w, h, alpha in TARGETS:
        print(f"{stem}:")
        mod = __import__(module)
        canvas = getattr(mod, builder)()
        svg_path = os.path.join(OUT, stem + ".svg")
        with open(svg_path, "w", encoding="utf-8") as fh:
            fh.write(canvas.render(mod.TITLE))
        print(f"  svg {os.path.getsize(svg_path) / 1024:.0f} KB")
        for warning in canvas.warn:
            print("  WARN", warning)
            failed = True
        if not svg_only:
            rasterize(svg_path, os.path.join(OUT, stem + ".png"), w, h, alpha)
    if failed:
        print("\nlayout warnings above: text overflowed its region")
        return 1
    print("\nok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
