#!/usr/bin/env python3
"""Generate every icon the app, the installer and the tray need, from ONE file.

Run from this directory:

    python make-icons.py

Reads source-icon.png (the brand asset) and writes:

    icon.png       1024  electron-builder's master for macOS and Linux
    tray-icon.png   512  downsampled to 16px at runtime, see main/tray.ts
    icon.ico             Windows, multi-resolution: the exe, the installer,
                         the taskbar and the window

ONE SOURCE, several sizes, on purpose. Hand-exported icons drift, and the drift
shows up as a tray wearing a mark the installer does not.

  This script used to DRAW the icon with Pillow primitives -- a rounded square
  and a letter N in the console's palette -- as a stand-in until the real brand
  asset existed. It exists now (source-icon.png), so the drawing is gone: a
  generated approximation sitting next to the real logo is just a second logo
  waiting to be shipped by mistake.

NOTHING IS CROPPED OR PADDED HERE, and that is deliberate. The source is a square
whose lower third is the UMS wordmark; any crop to "tighten" the mark, or any
re-centring on the N, takes a bite out of that text. Windows and macOS do not crop
an icon either -- they scale the square they are given -- so the whole square goes
in at every size and the wordmark cannot be clipped at any of them.

The one honest limitation: at the 16px tray size a wordmark this small is not
legible, on any icon. It is the correct silhouette and colour, which is what a
16px icon is actually for. Cropping to the N alone would read better there and
would mean two different marks, so it is not done without somebody asking for it.
"""

from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "source-icon.png"

# Windows picks the closest size out of the .ico rather than scaling, so ship every
# size the shell actually asks for. 256 is not optional: electron-builder rejects a
# Windows icon without it, and it is what the taskbar uses at high DPI.
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)

MASTER = 1024
TRAY = 512


def load_source() -> Image.Image:
    if not SOURCE.exists():
        raise SystemExit(
            f"make-icons: {SOURCE.name} is missing. It is the brand asset and the "
            "only definition of the mark; put it back rather than regenerating one."
        )

    img = Image.open(SOURCE).convert("RGBA")
    w, h = img.size

    if w != h:
        raise SystemExit(
            f"make-icons: {SOURCE.name} is {w}x{h}, not square. Every target here is "
            "a square, so a non-square source would be letterboxed or cropped -- and "
            "cropping is exactly what must not happen to the wordmark."
        )
    if w < MASTER:
        raise SystemExit(
            f"make-icons: {SOURCE.name} is {w}px; {MASTER}px is the minimum. Upscaling "
            "a smaller source produces a soft icon at exactly the sizes people look at."
        )

    return img


def resized(img: Image.Image, size: int) -> Image.Image:
    # LANCZOS, not the default: at these reduction ratios (3000 -> 16 is ~190x) a
    # box filter turns the thin diagonal of the N into aliased noise.
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    src = load_source()
    print(f"source: {SOURCE.name} {src.size[0]}x{src.size[1]}")

    master = resized(src, MASTER)
    master.save(HERE / "icon.png")
    print(f"wrote icon.png ({MASTER})")

    resized(src, TRAY).save(HERE / "tray-icon.png")
    print(f"wrote tray-icon.png ({TRAY})")

    # Pillow's ICO writer downsamples the image it is given for each requested
    # size. Hand it the 1024 master rather than the 3000 source: the intermediate
    # step is the one Pillow does anyway, and this keeps every artifact in this
    # directory derived from the same master.
    master.save(HERE / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print("wrote icon.ico", ICO_SIZES)


if __name__ == "__main__":
    main()
