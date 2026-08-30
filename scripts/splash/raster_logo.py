# -*- coding: utf-8 -*-
"""Turn a glow-on-dark raster logo into an additively-composable RGBA asset.

The supplied logo render is light painted on a dark plate. Pasting it as-is
onto another background shows the plate as a rectangle. Simply making the dark
pixels transparent does not work either: the glow is a *gradient* into the
background, so a hard key leaves a halo edge.

The correct treatment is to read the plate as an additive light source:

    lit    = source - plate                  (what the light actually added)
    alpha  = luminance(lit) * gain           (how much light is there)
    rgb    = lit / alpha                     (unpremultiply, so rgb*alpha = lit)

Compositing that RGBA with normal "over" blending onto any dark background
reproduces exactly what screen/additive blending would have produced, so the
logo melts into the target background instead of sitting on a tile.

    python scripts/splash/raster_logo.py SOURCE.png [-o OUT.png] [--plate auto|#RRGGBB]
                                         [--gain 1.15] [--gamma 0.95] [--trim]
"""
import argparse
import os
import sys

try:
    import numpy as np
    from PIL import Image
except ImportError:                                          # pragma: no cover
    sys.exit("needs Pillow and numpy:  pip install pillow numpy")

LUMA = np.array([0.2126, 0.7152, 0.0722])


def _hex_to_rgb(s):
    s = s.lstrip("#")
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255.0


def estimate_plate(a, border=6):
    """Median colour of the outer frame -- the dark plate the logo sits on."""
    edges = np.concatenate([
        a[:border].reshape(-1, 3), a[-border:].reshape(-1, 3),
        a[:, :border].reshape(-1, 3), a[:, -border:].reshape(-1, 3)])
    return np.median(edges, axis=0)


def fit_plate(a, percentile=22, degree=2):
    """Fit a smooth surface to the dark pixels.

    A flat black point cannot describe a plate that carries its own vignette or
    radial glow -- subtracting a constant then leaves that gradient baked into
    the alpha as a wide haze. Fitting a low-order polynomial to the darkest
    pixels models the plate itself, and only light the logo actually adds
    survives the subtraction.
    """
    h, w, _ = a.shape
    yy, xx = np.mgrid[0:h, 0:w]
    xn, yn = (xx / w - 0.5), (yy / h - 0.5)
    terms = [np.ones_like(xn), xn, yn]
    if degree >= 2:
        terms += [xn * xn, yn * yn, xn * yn]
    basis = np.stack([t.ravel() for t in terms], axis=1)

    lum = a @ LUMA
    mask = (lum <= np.percentile(lum, percentile)).ravel()
    plate = np.zeros_like(a)
    for ch in range(3):
        coef, *_ = np.linalg.lstsq(basis[mask], a[..., ch].ravel()[mask], rcond=None)
        plate[..., ch] = (basis @ coef).reshape(h, w)
    return np.clip(plate, 0.0, 1.0)


def key_glow(im, plate=None, gain=1.15, gamma=0.95, floor=2.0 / 255):
    """Return (rgba_image, plate_used, stats). `plate` may be a colour or a map."""
    a = np.asarray(im.convert("RGB"), dtype=np.float64) / 255.0
    if plate is None:
        plate = estimate_plate(a)
    elif isinstance(plate, str) and plate == "fit":
        plate = fit_plate(a)
    lit = np.clip(a - plate, 0.0, None)

    # Alpha follows the STRONGEST channel, not luminance. The mark is blue, and
    # blue carries only 0.07 of luma -- a luminance alpha would be far smaller
    # than the blue it has to carry, so lit/alpha would exceed 1 and clip, which
    # both dulls the colour and breaks the round trip. Max-channel guarantees
    # lit/alpha <= 1, so the unpremultiply is always exact.
    base = lit.max(axis=2)
    alpha = np.clip((base ** gamma) * gain, 0.0, 1.0)
    alpha[base < floor] = 0.0            # kill fit residuals -> true transparency

    rgb = np.divide(lit, alpha[..., None], out=np.zeros_like(lit),
                    where=alpha[..., None] > 1e-6)
    rgb = np.clip(rgb, 0.0, 1.0)
    rgba = (np.dstack([rgb, alpha]) * 255).round().astype(np.uint8)
    out = Image.fromarray(rgba, "RGBA")

    # round-trip check: compositing back onto the plate must rebuild the source
    recon = np.clip(rgb * alpha[..., None] + plate, 0, 1)
    err = np.abs(recon - a).max() * 255
    stats = {"plate": plate, "max_err": err,
             "transparent": float((alpha == 0).mean()),
             "opaque": float((alpha >= 0.999).mean())}
    return out, plate, stats


def trim(im, thresh=2):
    """Crop fully-transparent margins so the mark can be placed by its bbox."""
    a = np.asarray(im)[:, :, 3]
    ys, xs = np.where(a > thresh)
    if not len(ys):
        return im
    return im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("source")
    p.add_argument("-o", "--out")
    p.add_argument("--plate", default="fit",
                   help="'fit' (polynomial surface, handles vignettes), "
                        "'auto' (flat median of the border), or #RRGGBB")
    p.add_argument("--gain", type=float, default=1.15)
    p.add_argument("--gamma", type=float, default=0.95)
    p.add_argument("--trim", action="store_true",
                   help="crop fully transparent margins")
    args = p.parse_args(argv)

    im = Image.open(args.source)
    if args.plate == "auto":
        plate = None
    elif args.plate == "fit":
        plate = "fit"
    else:
        plate = _hex_to_rgb(args.plate)
    out, plate, st = key_glow(im, plate, args.gain, args.gamma)
    if args.trim:
        out = trim(out)
    dst = args.out or os.path.splitext(args.source)[0] + "-keyed.png"
    out.save(dst, optimize=True)

    flat = np.asarray(plate).reshape(-1, 3).mean(axis=0)
    ph = "#" + "".join(f"{int(round(v * 255)):02X}" for v in flat)
    if np.asarray(plate).ndim == 3:
        ph += " (mean of fitted surface)"
    print(f"source      {im.size} {im.mode}")
    print(f"plate       {ph}  (subtracted as the additive black point)")
    print(f"result      {out.size} RGBA -> {dst}")
    print(f"            {st['transparent'] * 100:.1f}% fully transparent, "
          f"{st['opaque'] * 100:.1f}% fully opaque")
    print(f"round-trip  max channel error vs source: {st['max_err']:.2f}/255")
    if st["max_err"] > 2.5:
        print("            ! high -- try a different --plate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
