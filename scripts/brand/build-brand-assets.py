"""Builds BondED's logo and app icons in any colourway from palettes.json.

    python scripts/brand/build-brand-assets.py --logo campus --icon maroon

Recolours the original artwork in scripts/brand/source/ — never the files in
assets/, which this overwrites — so any colourway can be rebuilt at any time,
including a return to the originals with --logo original --icon original.

Every pixel is sorted into a family (a ribbon's face, the bubble, the cap…)
by hue, saturation and lightness. Each family takes its new colour but keeps
how much lighter or darker each pixel was than the family as a whole, so the
folds, gradients and anti-aliased edges survive.

Writes:
  assets/images/BondEDlogo.png            the knot mark alone (the name is text)
  assets/images/splash-icon.png           the knot for the launch screen
  assets/images/icon.png                  the app icon, full-bleed
  assets/images/android-icon-*.png        adaptive icon layers
  assets/images/favicon.png               the web tab icon
  utils/brand.generated.ts                which colourway is live, for the app

Needs Pillow and NumPy:  pip install pillow numpy
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ASSETS = os.path.join(ROOT, "assets", "images")


def rgb_to_hls(arr):
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mx = arr[..., :3].max(-1)
    mn = arr[..., :3].min(-1)
    l = (mx + mn) / 2
    d = mx - mn
    s = np.where(d < 1e-6, 0, np.where(l < 0.5, d / (mx + mn + 1e-9), d / (2 - mx - mn + 1e-9)))
    rc = (mx - r) / (d + 1e-9)
    gc = (mx - g) / (d + 1e-9)
    bc = (mx - b) / (d + 1e-9)
    h = np.where(r == mx, bc - gc, np.where(g == mx, 2 + rc - bc, 4 + gc - rc))
    h = np.where(d < 1e-6, 0, (h / 6) % 1.0)
    return h, l, s


def hls_to_rgb(h, l, s):
    q = np.where(l < 0.5, l * (1 + s), l + s - l * s)
    p = 2 * l - q

    def channel(t):
        t = t % 1.0
        return np.where(t < 1 / 6, p + (q - p) * 6 * t,
               np.where(t < 1 / 2, q,
               np.where(t < 2 / 3, p + (q - p) * (2 / 3 - t) * 6, p)))

    return np.stack([channel(h + 1 / 3), channel(h), channel(h - 1 / 3)], -1)


def hex_to_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def recolour(arr, families, colours):
    h, l, s = rgb_to_hls(arr)
    out = arr.copy()
    for name, mask in families.items():
        if not mask.any() or name not in colours:
            continue
        target = np.array(hex_to_rgb(colours[name]), dtype=np.float64)[None, None, :] / 255
        th, tl, ts = (float(v[0, 0]) for v in rgb_to_hls(target))
        mean_l = float(l[mask].mean())
        new_l = np.clip(tl + (l[mask] - mean_l), 0, 1)
        out[..., :3][mask] = hls_to_rgb(np.full_like(new_l, th), new_l, np.full_like(new_l, ts))
    return out


def to_image(arr):
    return Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "RGBA")


def load(path):
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.float64) / 255


# ── The knot ────────────────────────────────────────────────────────────
def knot_families(arr):
    h, l, s = rgb_to_hls(arr)
    hue = h * 360
    alpha = arr[..., 3] > 0.02
    light = l > 0.5
    grey_band = alpha & light & (s < 0.15)
    mint_band = alpha & light & ~grey_band & (hue > 120) & (hue < 200)
    grey_band = grey_band | (alpha & light & ~grey_band & ~mint_band)
    teal_fold = alpha & ~light & (hue > 150) & (hue < 215) & (s > 0.12)
    navy = alpha & ~light & ~teal_fold & (s > 0.33)
    # The navy ribbon's face and fold are close in lightness, and noise in the
    # source speckled one into the other; judge by the neighbourhood instead.
    padded = np.pad(l, 2, mode="edge")
    smooth = sum(padded[dy:dy + l.shape[0], dx:dx + l.shape[1]] for dy in range(5) for dx in range(5)) / 25
    navy_band = navy & (smooth > 0.21)
    return {
        "greyBand": grey_band,
        "greyFold": alpha & ~light & ~teal_fold & ~navy,
        "navyBand": navy_band,
        "navyFold": navy & ~navy_band,
        "mintBand": mint_band,
        "mintFold": teal_fold,
    }


def export_logo(knot):
    mark = to_image(knot)
    # The source is small, so it is enlarged once, carefully, and sharpened.
    side = max(mark.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(mark, ((side - mark.width) // 2, (side - mark.height) // 2))
    big = square.resize((768, 768), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=2, percent=70, threshold=2))
    big.save(os.path.join(ASSETS, "BondEDlogo.png"), optimize=True)

    splash = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    inner = big.resize((720, 720), Image.LANCZOS)
    splash.alpha_composite(inner, (152, 152))
    splash.save(os.path.join(ASSETS, "splash-icon.png"), optimize=True)


# ── The app icon ────────────────────────────────────────────────────────
def icon_art(path):
    """The rounded square from the source image, without the page behind it."""
    img = Image.open(path).convert("RGBA")
    arr = np.asarray(img).astype(np.float64) / 255
    _, l, s = rgb_to_hls(arr)
    ys, xs = np.where((s > 0.35) & (l < 0.85))
    square = img.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    mask = Image.new("L", square.size, 0)
    radius = int(min(square.size) * 0.22)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, square.width - 1, square.height - 1), radius, fill=255)
    square.putalpha(mask)
    return np.asarray(square).astype(np.float64) / 255


def icon_families(arr):
    h, l, s = rgb_to_hls(arr)
    hue = h * 360
    alpha = arr[..., 3] > 0.02
    # The bubble and its soft shadow: anything this pale belongs to it. The
    # shadow's faint lilac used to be sorted as background and came out as
    # dark specks inside the bubble.
    bubble = alpha & (l > 0.78)
    cap = alpha & ~bubble & (l < 0.33)
    cyan = alpha & ~bubble & ~cap & (hue > 150) & (hue < 205)
    purple = alpha & ~bubble & ~cap & ~cyan & (hue >= 205) & (hue < 300)
    deep = purple & (l < 0.52)
    rest = alpha & ~bubble & ~cap & ~cyan & ~purple
    return {"bubble": bubble | rest, "cap": cap, "top": cyan, "bottom": purple & ~deep, "deep": deep}


INSET = 0.08


def inside_corners(img):
    """Crops inside the rounded corners so the launcher's own mask shapes the
    icon — the old one had its square baked in, so Android framed it twice."""
    w, h = img.size
    inset = round(min(w, h) * INSET)
    return img.crop((inset, inset, w - inset, h - inset))


def full_bleed(img, background):
    art = inside_corners(img).resize((1024, 1024), Image.LANCZOS)
    canvas = Image.new("RGBA", (1024, 1024), hex_to_rgb(background) + (255,))
    canvas.alpha_composite(art)
    return canvas


ADAPTIVE_SCALE = 0.6


def adaptive_layer(img, scale=ADAPTIVE_SCALE):
    """Android shows only the middle two-thirds of an adaptive icon, then cuts
    it to the launcher's shape, so the artwork is set smaller and its edges
    are carried outwards to fill the rest."""
    size = round(1024 * scale)
    art = np.asarray(img.resize((size, size), Image.LANCZOS))
    pad = (1024 - size) // 2
    art = np.pad(art, ((pad, 1024 - size - pad), (pad, 1024 - size - pad), (0, 0)), mode="edge")
    return Image.fromarray(art, img.mode)


def silhouette(mask):
    """A clean single-colour shape: stray pixels closed up, edges softened.
    The cap and the bubble stay separate shapes."""
    shape = Image.fromarray((mask * 255).astype(np.uint8), "L")
    return shape.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))


def export_icon(art, families, colours):
    background = colours.get("bottom", "#5f0909")
    icon = full_bleed(to_image(art), background)
    # iOS and older Android mask the whole image, so it can fill the square.
    icon.convert("RGB").save(os.path.join(ASSETS, "icon.png"), optimize=True)
    icon.convert("RGB").resize((64, 64), Image.LANCZOS).save(os.path.join(ASSETS, "favicon.png"), optimize=True)
    adaptive_layer(icon.convert("RGB")).save(os.path.join(ASSETS, "android-icon-foreground.png"), optimize=True)
    Image.new("RGB", (1024, 1024), hex_to_rgb(background)).save(os.path.join(ASSETS, "android-icon-background.png"))

    # Themed icons (Android 13+) tint a single-colour silhouette: the bubble
    # and the cap, in white, on nothing, at the same size as the layer above.
    shape = inside_corners(silhouette(families["bubble"] | families["cap"])).resize((1024, 1024), Image.LANCZOS)
    small = np.asarray(shape.resize((round(1024 * ADAPTIVE_SCALE),) * 2, Image.LANCZOS))
    pad = (1024 - small.shape[0]) // 2
    alpha = Image.fromarray(np.pad(small, ((pad, 1024 - small.shape[0] - pad),) * 2), "L")
    mono = Image.new("RGBA", (1024, 1024), (255, 255, 255, 255))
    mono.putalpha(alpha)
    mono.save(os.path.join(ASSETS, "android-icon-monochrome.png"), optimize=True)


def main():
    palettes = json.load(open(os.path.join(HERE, "palettes.json"), encoding="utf-8"))
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--logo", default="campus", choices=["original"] + list(palettes["knot"]))
    parser.add_argument("--icon", default="maroon", choices=["original"] + list(palettes["icon"]))
    args = parser.parse_args()

    knot = load(os.path.join(HERE, "source", "knot-original.png"))
    if args.logo != "original":
        knot = recolour(knot, knot_families(knot), palettes["knot"][args.logo]["colours"])
    export_logo(knot)

    art = icon_art(os.path.join(HERE, "source", "app-icon-original.png"))
    families = icon_families(art)
    icon_colours = {"bottom": "#827df1"}
    if args.icon != "original":
        icon_colours = palettes["icon"][args.icon]["colours"]
        art = recolour(art, families, icon_colours)
    export_icon(art, families, icon_colours)

    accent = "#9cccbc" if args.logo == "original" else palettes["knot"][args.logo]["ed"]
    with open(os.path.join(ROOT, "utils", "brand.generated.ts"), "w", encoding="utf-8", newline="\n") as out:
        out.write(
            "// Generated by scripts/brand/build-brand-assets.py — don't edit by hand;\n"
            "// run the script with another --logo / --icon to change colourway.\n"
            "export const BRAND_COLOURWAY = {\n"
            f'  logo: "{args.logo}",\n'
            f'  icon: "{args.icon}",\n'
            "  /** The \"ED\" of the wordmark, matched to the logo. */\n"
            f'  wordmarkAccent: "{accent}",\n'
            "} as const;\n"
        )
    print(f"Built logo '{args.logo}' and icon '{args.icon}'. Rebuild the app to see them.")


if __name__ == "__main__":
    main()
