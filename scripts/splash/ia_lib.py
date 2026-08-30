"""Shared drawing library for the InfoApex AI splash artwork.

Everything is emitted as true vector primitives. Text is converted to outline
paths so the SVG is font-independent and renders identically everywhere.
"""
import math
import os

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
CACHE = os.path.join(FONT_DIR, "_instances")

# ----------------------------------------------------------------- palette
BG_DEEP = "#04070E"
BG_MID = "#070E1A"
PANEL = "#0A1424"
PANEL2 = "#0C1A2D"
EDGE = "#1C2E4A"
EDGE_HI = "#2C486F"
TXT = "#EAF1FA"
SUB = "#93A7C2"
DIM = "#61789A"
FAINT = "#3E5273"
BLUE = "#2F9BFF"
ICE = "#7FD3FF"
DEEP = "#1A6FD4"
AMBER = "#F0B429"
GREEN = "#3DD68C"


# ----------------------------------------------------------------- fonts
def _instance(src, name, **axes):
    """Materialize a static instance of a variable font (cached on disk)."""
    from fontTools.ttLib import TTFont
    os.makedirs(CACHE, exist_ok=True)
    dst = os.path.join(CACHE, name)
    if not os.path.exists(dst):
        from fontTools.varLib import instancer
        f = TTFont(os.path.join(FONT_DIR, src))
        instancer.instantiateVariableFont(f, axes, inplace=True)
        f.save(dst)
    return dst


class Font:
    def __init__(self, path):
        from fontTools.ttLib import TTFont
        self.tt = TTFont(path)
        self.upm = self.tt["head"].unitsPerEm
        self.cmap = self.tt.getBestCmap()
        self.gs = self.tt.getGlyphSet()
        self.hmtx = self.tt["hmtx"]
        self.kern = {}
        if "kern" in self.tt:
            for st in self.tt["kern"].kernTables:
                self.kern.update(st.kernTable)

    def _g(self, ch):
        return self.cmap.get(ord(ch)) or ".notdef"

    def width(self, text, size, tracking=0.0):
        s = size / self.upm
        total, prev = 0.0, None
        for ch in text:
            gn = self._g(ch)
            if prev is not None:
                total += self.kern.get((prev, gn), 0) * s
            total += self.hmtx[gn][0] * s + tracking
            prev = gn
        return total - tracking if text else 0.0

    def path(self, text, x, y, size, tracking=0.0):
        from fontTools.pens.svgPathPen import SVGPathPen
        from fontTools.pens.transformPen import TransformPen
        from fontTools.misc.transform import Transform
        s = size / self.upm
        pen = SVGPathPen(self.gs, ntos=lambda v: f"{round(v, 2):g}")
        cx, prev = x, None
        for ch in text:
            gn = self._g(ch)
            if prev is not None:
                cx += self.kern.get((prev, gn), 0) * s
            if not ch.isspace():
                self.gs[gn].draw(TransformPen(pen, Transform(s, 0, 0, -s, cx, y)))
            cx += self.hmtx[gn][0] * s + tracking
            prev = gn
        return pen.getCommands()


def load_fonts():
    return {
        "display": Font(os.path.join(FONT_DIR, "Poppins-Bold.ttf")),
        "display_semi": Font(os.path.join(FONT_DIR, "Poppins-SemiBold.ttf")),
        "display_med": Font(os.path.join(FONT_DIR, "Poppins-Medium.ttf")),
        "bold": Font(_instance("Inter[opsz,wght].ttf", "Inter-700.ttf", wght=700, opsz=14)),
        "semi": Font(_instance("Inter[opsz,wght].ttf", "Inter-600.ttf", wght=600, opsz=14)),
        "med": Font(_instance("Inter[opsz,wght].ttf", "Inter-500.ttf", wght=500, opsz=14)),
        "reg": Font(_instance("Inter[opsz,wght].ttf", "Inter-400.ttf", wght=400, opsz=14)),
        "mono": Font(_instance("JetBrainsMono[wght].ttf", "JBMono-400.ttf", wght=400)),
        "mono_bold": Font(_instance("JetBrainsMono[wght].ttf", "JBMono-700.ttf", wght=700)),
    }


# ----------------------------------------------------------------- canvas
class Canvas:
    def __init__(self, w, h, fonts):
        self.w, self.h = w, h
        self.f = fonts
        self.out = []
        self.defs = []
        self.warn = []
        self._uid = 0

    def add(self, s):
        self.out.append(s)

    def uid(self, p="u"):
        self._uid += 1
        return f"{p}{self._uid}"

    # -- text ---------------------------------------------------------
    def text(self, s, x, y, size, fill, font="reg", tracking=0.0,
             anchor="start", opacity=None, limit=None, min_x=None):
        f = self.f[font]
        w = f.width(s, size, tracking)
        if anchor == "middle":
            x -= w / 2
        elif anchor == "end":
            x -= w
        if limit is not None and x + w > limit + 0.5:
            self.warn.append(f"right-overflow {x + w - limit:6.1f}px | {s[:46]!r}")
        if min_x is not None and x < min_x - 0.5:
            self.warn.append(f"left-overflow  {min_x - x:6.1f}px | {s[:46]!r}")
        o = f' opacity="{opacity}"' if opacity is not None else ""
        self.add(f'<path fill="{fill}"{o} d="{f.path(s, x, y, size, tracking)}"/>')
        return w

    def measure(self, s, size, font="reg", tracking=0.0):
        return self.f[font].width(s, size, tracking)

    # -- primitives ---------------------------------------------------
    def rect(self, x, y, w, h, r=0, fill="none", stroke=None, sw=1, **kw):
        a = f'<rect x="{n(x)}" y="{n(y)}" width="{n(w)}" height="{n(h)}"'
        if r:
            a += f' rx="{n(r)}" ry="{n(r)}"'
        a += f' fill="{fill}"'
        if stroke:
            a += f' stroke="{stroke}" stroke-width="{n(sw)}"'
        for k, v in kw.items():
            a += f' {k.replace("_", "-")}="{v}"'
        self.add(a + "/>")

    def circle(self, cx, cy, r, fill="none", stroke=None, sw=1, **kw):
        a = f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="{fill}"'
        if stroke:
            a += f' stroke="{stroke}" stroke-width="{n(sw)}"'
        for k, v in kw.items():
            a += f' {k.replace("_", "-")}="{v}"'
        self.add(a + "/>")

    def line(self, x1, y1, x2, y2, stroke, sw=1, **kw):
        a = (f'<line x1="{n(x1)}" y1="{n(y1)}" x2="{n(x2)}" y2="{n(y2)}" '
             f'stroke="{stroke}" stroke-width="{n(sw)}"')
        for k, v in kw.items():
            a += f' {k.replace("_", "-")}="{v}"'
        self.add(a + "/>")

    def path(self, d, fill="none", stroke=None, sw=1, **kw):
        a = f'<path d="{d}" fill="{fill}"'
        if stroke:
            a += f' stroke="{stroke}" stroke-width="{n(sw)}"'
        for k, v in kw.items():
            a += f' {k.replace("_", "-")}="{v}"'
        self.add(a + "/>")

    def poly(self, pts, fill="none", stroke=None, sw=1, **kw):
        p = " ".join(f"{n(x)},{n(y)}" for x, y in pts)
        a = f'<polygon points="{p}" fill="{fill}"'
        if stroke:
            a += f' stroke="{stroke}" stroke-width="{n(sw)}"'
        for k, v in kw.items():
            a += f' {k.replace("_", "-")}="{v}"'
        self.add(a + "/>")

    def render(self, title):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" '
                f'height="{self.h}" viewBox="0 0 {self.w} {self.h}" fill="none">\n'
                f'<title>{title}</title>\n<defs>\n' + "\n".join(self.defs) +
                "\n</defs>\n" + "\n".join(self.out) + "\n</svg>\n")


def n(v):
    return f"{round(v + 0.0, 2):g}"


def raster(c, path, cx, width, cy=None, top=None, max_px=None, opacity=None):
    """Embed a keyed RGBA raster, centred on (cx, cy), scaled to `width`.

    Used for the InfoApex logo, which is a light-painted render rather than a
    constructible shape. The asset is pre-keyed by scripts/splash/raster_logo.py
    so its dark plate has become alpha; dropped in here it composites additively
    onto the artwork with no visible tile behind it.
    """
    import base64
    import io
    from PIL import Image

    im = Image.open(path).convert("RGBA")
    if max_px and im.width > max_px:                 # keep the payload sane
        im = im.resize((max_px, round(im.height * max_px / im.width)),
                       Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    h = width * im.height / im.width
    y = top if top is not None else cy - h / 2
    o = f' opacity="{opacity}"' if opacity else ""
    c.add(f'<image x="{n(cx - width / 2)}" y="{n(y)}" width="{n(width)}" '
          f'height="{n(h)}"{o} href="data:image/png;base64,{b64}"/>')
    return dict(w=width, h=h, top=y, bottom=y + h,
                left=cx - width / 2, right=cx + width / 2)


def hexagon(cx, cy, r, pointy=True):
    pts = []
    for i in range(6):
        a = math.radians(60 * i - (90 if pointy else 0))
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def arrow_head(c, x, y, ang, size, fill):
    b = size * 0.62
    p1 = (x, y)
    p2 = (x - size * math.cos(ang) + b * math.sin(ang),
          y - size * math.sin(ang) - b * math.cos(ang))
    p3 = (x - size * math.cos(ang) - b * math.sin(ang),
          y - size * math.sin(ang) + b * math.cos(ang))
    c.poly([p1, p2, p3], fill=fill)


def arrow(c, x1, y1, x2, y2, color, sw=1.6, head=8, gap=0.0):
    ang = math.atan2(y2 - y1, x2 - x1)
    if gap:
        x1 += gap * math.cos(ang); y1 += gap * math.sin(ang)
        x2 -= gap * math.cos(ang); y2 -= gap * math.sin(ang)
    c.line(x1, y1, x2 - head * 0.75 * math.cos(ang), y2 - head * 0.75 * math.sin(ang),
           color, sw, stroke_linecap="round")
    arrow_head(c, x2, y2, ang, head, color)


def card(c, x, y, w, h, r=12, fill=None, stroke=EDGE, sw=1.1, accent=None):
    c.rect(x, y, w, h, r, fill=fill or "url(#cardGrad)", stroke=stroke, sw=sw)
    if accent:
        cid = c.uid("clip")
        c.defs.append(f'<clipPath id="{cid}"><rect x="{n(x)}" y="{n(y)}" '
                      f'width="{n(w)}" height="{n(h)}" rx="{n(r)}" ry="{n(r)}"/></clipPath>')
        c.add(f'<g clip-path="url(#{cid})"><rect x="{n(x)}" y="{n(y)}" width="3.5" '
              f'height="{n(h)}" fill="{accent}"/></g>')


def panel(c, x, y, w, h, r=14):
    c.rect(x, y, w, h, r, fill="url(#panelGrad)", stroke=EDGE, sw=1.1)


def corner_brackets(c, x, y, w, h, size, color, sw=1.6):
    for sx, sy, ox, oy in ((1, 1, x, y), (-1, 1, x + w, y),
                           (1, -1, x, y + h), (-1, -1, x + w, y + h)):
        c.path(f"M{n(ox + sx * size)} {n(oy)}L{n(ox)} {n(oy)}L{n(ox)} {n(oy + sy * size)}",
               stroke=color, sw=sw, stroke_linecap="round")
