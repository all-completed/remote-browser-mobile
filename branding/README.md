# App icon assets

The launcher icon — a gold key-in-shield inside a browser window on royal blue —
representing the Keeper as a guardian that delivers secrets safely into a remote
browser.

**Flat by design.** Solid colours only: no gradients, no simulated volume, no painted
drop shadow. The platforms add their own depth (launcher masks, elevation, menu-bar
tinting), so baking it into the artwork only fights them. The palette is `#1C4EA6`
(royal blue, the midpoint of the retired `#2F7DFF → #0A1F4D` gradient), `#F4C656`
(gold, the middle stop of the retired three-stop gold) and `#F4F7FF` (window outline).

## Sources (hand-authored, edit these)

- `icon.svg` — the canonical launcher mark; the desktop keeper renders its
  icns/ico/png from this file. Edit here to change the mark everywhere.
- `icon-foreground.svg` — the same emblem on transparent, scaled into the adaptive
  icon's safe zone (66dp of the 108dp canvas).
- `glyph-shield-keeper.svg` — the small monochrome glyph (shield + keyhole, line art).
  One glyph, rendered twice: Android's `drawable/ic_stat_keeper.xml` and the macOS
  tray image in `all-completed/remote-browser-keeper` both carry this path data.
  Keep them in sync.

## Generated (do not hand-edit)

Run the generator after any change to `icon.svg` / `icon-foreground.svg`:

```sh
npm i --no-save @resvg/resvg-js && node branding/generate-icons.mjs
```

- `icon-1024.png` — full-bleed legacy/master icon.
- `icon-foreground-1024.png` — adaptive-icon foreground master.
- `android/app/src/main/res/mipmap-*/ic_launcher.png` (rounded square),
  `ic_launcher_round.png` (circle), `ic_launcher_foreground.png` (adaptive
  foreground) at all five densities — launcher 48/72/96/144/192, foreground
  108/162/216/324/432.

`drawable/ic_launcher_background.xml` is the adaptive background: a solid
`@color/ic_launcher_background` rectangle.

## Reference

- `previews/` — rendered before/after checks kept with the artwork: the status-bar
  glyph at every density, the launcher icons, the mark under each adaptive mask, and
  the Android/macOS glyph parity.
- `originals/` — the raw, unmodified OpenAI `gpt-image-1` generations that the design
  came from: `gpt-image-gen1.png` and `gpt-image-gen2-chosen.png` (the one used).
- `emblem-source-transparent.png` — the chosen emblem on transparent bg (= gen2).
  Historical: it carries the old gradients and drop shadow and is no longer an input
  to anything; the flat vectors above supersede it.
