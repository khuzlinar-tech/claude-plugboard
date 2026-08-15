'use strict';

/*
 * The tray icon, redrawn as usage changes.
 *
 * A Windows tray icon is 16 logical pixels, so there is no room for a font: the
 * digits are a hand-built 3x5 bitmap scaled to fit. Everything is drawn into a
 * raw RGBA buffer and encoded as PNG, with no image library involved.
 */

const { encodePng } = require('./png');

// 3x5 bitmap digits, one string of three characters per row.
const DIGITS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

const COLORS = {
  ok: [0xd9, 0x77, 0x57],
  warn: [0xe0, 0xa4, 0x58],
  danger: [0xd9, 0x60, 0x5a],
  mono: [0xe8, 0xe6, 0xe0],
  dim: [0x6b, 0x64, 0x5d],
  cardBack: [0x74, 0x84, 0xa0],
  cardFront: [0xe4, 0xa0, 0x62],
};

function levelColor(pct, mono) {
  if (mono) return COLORS.mono;
  if (pct >= 90) return COLORS.danger;
  if (pct >= 70) return COLORS.warn;
  return COLORS.ok;
}

/** Simple RGBA canvas with source-over compositing. */
function canvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  return {
    buf,
    size,
    px(x, y, colour, alpha = 1) {
      if (x < 0 || y < 0 || x >= size || y >= size || alpha <= 0) return;
      const o = (y * size + x) * 4;
      const a = Math.min(1, alpha);
      const inv = 1 - a;
      buf[o] = Math.round(colour[0] * a + buf[o] * inv);
      buf[o + 1] = Math.round(colour[1] * a + buf[o + 1] * inv);
      buf[o + 2] = Math.round(colour[2] * a + buf[o + 2] * inv);
      buf[o + 3] = Math.round(255 * a + buf[o + 3] * inv);
    },
    rect(x0, y0, w, h, colour, alpha = 1) {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.px(x, y, colour, alpha);
    },
    /** Rounded rectangle, corners cut rather than antialiased — crisp at 16px. */
    roundRect(x0, y0, w, h, r, colour, alpha = 1) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = Math.min(x, w - 1 - x);
          const dy = Math.min(y, h - 1 - y);
          if (dx < r && dy < r && (r - dx) * (r - dx) + (r - dy) * (r - dy) > r * r + 1) continue;
          this.px(x0 + x, y0 + y, colour, alpha);
        }
      }
    },
  };
}

function drawDigits(c, text, x, y, scale, colour) {
  let cx = x;
  for (const ch of text) {
    const glyph = DIGITS[ch];
    if (!glyph) {
      cx += scale * 2;
      continue;
    }
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        c.rect(cx + gx * scale, y + gy * scale, scale, scale, colour);
      }
    }
    cx += scale * 4;
  }
  return cx - x - scale; // width drawn, minus the trailing gap
}

function digitsWidth(text, scale) {
  return text.length * scale * 4 - scale;
}

/* -------------------------------------------------------------- styles */

/** The static two-card mark, same shapes as the app icon. */
function drawMark(c, s) {
  const u = s / 16;
  c.roundRect(Math.round(1 * u), Math.round(1 * u), Math.round(8 * u), Math.round(8 * u), Math.max(1, Math.round(1.5 * u)), COLORS.cardBack);
  c.roundRect(Math.round(6 * u), Math.round(6 * u), Math.round(9 * u), Math.round(9 * u), Math.max(1, Math.round(1.5 * u)), COLORS.cardFront);
}

function styleIcon(c, s) {
  drawMark(c, s);
}

/** The mark with a usage bar along the bottom. */
function styleBar(c, s, pct, colour) {
  const u = s / 16;
  const barH = Math.max(2, Math.round(3 * u));
  const top = s - barH;

  // Mark shrunk to leave room for the bar.
  const m = Math.round(s - barH - 1);
  c.roundRect(0, 0, Math.round(m * 0.6), Math.round(m * 0.6), Math.max(1, Math.round(u)), COLORS.cardBack);
  c.roundRect(Math.round(m * 0.35), Math.round(m * 0.35), Math.round(m * 0.65), Math.round(m * 0.65), Math.max(1, Math.round(u)), COLORS.cardFront);

  c.rect(0, top, s, barH, COLORS.dim, 0.55);
  c.rect(0, top, Math.round((s * Math.min(100, pct)) / 100), barH, colour);
}

/**
 * Just the number. A full window becomes a solid block rather than a rounded-down
 * "99", which would understate exactly when it matters most. One- and two-digit
 * values share a scale so the icon does not change weight as usage climbs.
 */
function stylePercent(c, s, pct, colour) {
  if (pct >= 100) {
    const m = Math.round(s * 0.72);
    c.roundRect(Math.round((s - m) / 2), Math.round((s - m) / 2), m, m, Math.max(1, Math.round(s / 8)), colour);
    return;
  }
  const text = String(Math.max(0, Math.round(pct)));
  const scale = Math.max(1, Math.floor(s / 9)); // sized for two digits, always
  const w = digitsWidth(text, scale);
  drawDigits(c, text, Math.round((s - w) / 2), Math.round((s - scale * 5) / 2), scale, colour);
}

/** A battery outline filled in proportion to usage. */
function styleBattery(c, s, pct, colour) {
  const u = s / 16;
  const x0 = Math.round(1 * u);
  const y0 = Math.round(4 * u);
  const w = Math.round(12 * u);
  const h = Math.round(8 * u);
  const border = Math.max(1, Math.round(u));

  // Outline
  c.rect(x0, y0, w, border, COLORS.mono, 0.85);
  c.rect(x0, y0 + h - border, w, border, COLORS.mono, 0.85);
  c.rect(x0, y0, border, h, COLORS.mono, 0.85);
  c.rect(x0 + w - border, y0, border, h, COLORS.mono, 0.85);
  // Terminal nub
  c.rect(x0 + w, y0 + Math.round(h / 3), Math.max(1, Math.round(1.5 * u)), Math.round(h / 3), COLORS.mono, 0.85);

  const innerW = w - border * 4;
  const fill = Math.round((innerW * Math.min(100, pct)) / 100);
  if (fill > 0) c.rect(x0 + border * 2, y0 + border * 2, fill, h - border * 4, colour);
}

/**
 * @param {{style:string, pct:number, size:number, mono?:boolean}} opts
 * @returns {Buffer} PNG
 */
function render({ style = 'icon', pct = 0, size = 16, mono = false }) {
  const c = canvas(size);
  const colour = levelColor(pct, mono);

  switch (style) {
    case 'bar':
      styleBar(c, size, pct, colour);
      break;
    case 'percent':
      stylePercent(c, size, pct, colour);
      break;
    case 'battery':
      styleBattery(c, size, pct, colour);
      break;
    default:
      styleIcon(c, size);
  }

  return encodePng(c.buf, size);
}

const STYLES = ['icon', 'bar', 'percent', 'battery'];

module.exports = { render, STYLES };
