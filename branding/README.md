# App icon assets

The launcher icon — a gold key-in-shield inside a browser window on a royal-blue
gradient — representing the Keeper as a guardian that delivers secrets safely into a
remote browser.

- `emblem-source-transparent.png` — the emblem on transparent bg, generated with
  OpenAI `gpt-image-1`.
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
