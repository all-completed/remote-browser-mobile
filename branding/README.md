# App icon assets

The launcher icon — a gold key-in-shield inside a browser window on a royal-blue
gradient — representing the Keeper as a guardian that delivers secrets safely into a
remote browser.

- `icon.svg` — the canonical hand-authored vector; the desktop keeper renders its
  icns/ico/png from this file. Edit here to change the mark everywhere.
- `originals/` — the raw, unmodified OpenAI `gpt-image-1` generations:
  `gpt-image-gen1.png` (first variant) and `gpt-image-gen2-chosen.png` (the one used).
- `emblem-source-transparent.png` — the chosen emblem on transparent bg (= gen2).
- `icon-1024.png` — full legacy/master icon (emblem composited on the blue gradient).
- `icon-foreground-1024.png` — adaptive-icon foreground (emblem, transparent, padded
  into the safe zone).

Generated Android assets (committed under `android/app/src/main/res/`):
- `mipmap-*/ic_launcher.png` (rounded), `ic_launcher_round.png` (circle),
  `ic_launcher_foreground.png` (adaptive foreground) at all densities.
- `drawable/ic_launcher_background.xml` — the blue gradient (adaptive background).

To regenerate density PNGs from the masters, resize with ImageMagick to the standard
mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi sizes (launcher 48/72/96/144/192; foreground
108/162/216/324/432).
