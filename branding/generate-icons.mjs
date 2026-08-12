// Regenerates every raster icon from the canonical vectors in this directory.
//
//   npm i --no-save @resvg/resvg-js && node branding/generate-icons.mjs
//
// (installed --no-save on purpose: icon generation is a one-off authoring step, not
// something the app build needs, so it stays out of package.json)
//
// Sources          → outputs
//   icon.svg            → icon-1024.png (full-bleed master),
//                         mipmap-*/ic_launcher.png (rounded square, 48/72/96/144/192),
//                         mipmap-*/ic_launcher_round.png (circle, same sizes)
//   icon-foreground.svg → icon-foreground-1024.png,
//                         mipmap-*/ic_launcher_foreground.png (108/162/216/324/432)
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const res = join(here, '..', 'android', 'app', 'src', 'main', 'res')

// Densities: mdpi, hdpi, xhdpi, xxhdpi, xxxhdpi. Launcher 48dp, adaptive foreground 108dp.
const DENSITIES = [
  ['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4],
]
const BACKGROUND = '#1C4EA6' // keep in sync with icon.svg and values/ic_launcher_background.xml

function render(svgPath, size) {
  const r = new Resvg(readFileSync(svgPath), {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  })
  return r.render() // RGBA pixel buffer + width/height
}

// PNG encoding is done by resvg for the plain cases; the circular variant needs the
// alpha channel rewritten, so it is composed here on the raw RGBA buffer.
function circleMasked(img) {
  const { width: w, height: h } = img
  const px = Buffer.from(img.pixels)
  const c = (w - 1) / 2
  const r = w / 2
  const SS = 4 // supersample the mask edge so the circle stays smooth at 48px
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - 0.5 - c
          const dy = y + (sy + 0.5) / SS - 0.5 - c
          if (dx * dx + dy * dy <= r * r) inside++
        }
      }
      const i = (y * w + x) * 4 + 3
      px[i] = Math.round((px[i] * inside) / (SS * SS))
    }
  }
  return { pixels: px, width: w, height: h }
}

// Minimal PNG writer (RGBA, no filtering) — avoids pulling in an image library.
import { deflateSync } from 'node:zlib'
function rgbaToPng(px, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter type: none
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const chunks = []
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    chunks.push(len, body, crc)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  chunk('IHDR', ihdr)
  chunk('IDAT', deflateSync(raw, { level: 9 }))
  chunk('IEND', Buffer.alloc(0))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks])
}
let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

function flatten(img, hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const px = Buffer.from(img.pixels)
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255
    px[i] = Math.round(px[i] * a + r * (1 - a))
    px[i + 1] = Math.round(px[i + 1] * a + g * (1 - a))
    px[i + 2] = Math.round(px[i + 2] * a + b * (1 - a))
    px[i + 3] = 255
  }
  return { pixels: px, width: img.width, height: img.height }
}

const write = (path, img) => {
  writeFileSync(path, rgbaToPng(Buffer.from(img.pixels), img.width, img.height))
  console.log('wrote', path, `${img.width}×${img.height}`)
}

const iconSvg = join(here, 'icon.svg')
const fgSvg = join(here, 'icon-foreground.svg')

// Masters
write(join(here, 'icon-1024.png'), flatten(render(iconSvg, 1024), BACKGROUND))
write(join(here, 'icon-foreground-1024.png'), render(fgSvg, 1024))

// Android densities
for (const [density, scale] of DENSITIES) {
  const launcher = Math.round(48 * scale)
  const square = render(iconSvg, launcher)
  write(join(res, `mipmap-${density}`, 'ic_launcher.png'), square)
  write(join(res, `mipmap-${density}`, 'ic_launcher_round.png'), circleMasked(render(iconSvg, launcher)))
  write(join(res, `mipmap-${density}`, 'ic_launcher_foreground.png'), render(fgSvg, Math.round(108 * scale)))
}
