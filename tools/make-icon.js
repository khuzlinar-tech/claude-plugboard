'use strict';

/*
 * Генерирует иконки без внешних зависимостей: рисуем пиксели вручную,
 * кодируем PNG через zlib, складываем в ICO-контейнер.
 *
 * Мотив — две карточки со смещением: «переключение между учётными записями».
 * Намеренно не похоже на знак Claude: это сторонний инструмент, а не продукт Anthropic.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x2a, 0x2f, 0x3b]; // тёмный сланец
const BACK = [0x74, 0x84, 0xa0]; // задняя карточка
const FRONT = [0xe4, 0xa0, 0x62]; // передняя карточка
const SS = 4; // сглаживание суперсэмплингом

/** Точка внутри прямоугольника со скруглёнными углами. */
function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return Math.hypot(px - cx, py - cy) <= r + 1e-6;
}

/** Возвращает цвет точки или null, если она вне иконки. */
function shade(px, py, size) {
  const u = px / size;
  const v = py / size;

  if (!inRoundRect(u, v, 0, 0, 1, 1, 0.215)) return null;

  const back = [0.2, 0.18, 0.63, 0.61];
  const front = [0.35, 0.37, 0.78, 0.8];
  const cr = 0.075;
  const halo = 0.035;

  if (inRoundRect(u, v, front[0], front[1], front[2], front[3], cr)) return FRONT;
  if (inRoundRect(u, v, front[0] - halo, front[1] - halo, front[2] + halo, front[3] + halo, cr + halo)) return BG;
  if (inRoundRect(u, v, back[0], back[1], back[2], back[3], cr)) return BACK;
  return BG;
}

function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const step = 1 / SS;
  const n = SS * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          hits++;
        }
      }
      const o = (y * size + x) * 4;
      if (hits) {
        buf[o] = Math.round(r / hits);
        buf[o + 1] = Math.round(g / hits);
        buf[o + 2] = Math.round(b / hits);
        buf[o + 3] = Math.round((hits / n) * 255);
      }
    }
  }
  return buf;
}

/* ------------------------------------------------------------ PNG-кодер */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // глубина канала
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // фильтр None
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------- ICO-контейнер */

function buildIco(sizes) {
  const images = sizes.map((s) => encodePng(renderRGBA(s), s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  let offset = 6 + sizes.length * 16;
  const entries = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...images]);
}

const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });

const targets = [
  ['icon.ico', buildIco([256, 128, 64, 48, 32, 16])],
  ['tray.ico', buildIco([32, 24, 20, 16])],
  ['icon-256.png', encodePng(renderRGBA(256), 256)],
];

for (const [name, buf] of targets) {
  fs.writeFileSync(path.join(assets, name), buf);
  console.log(`${name}: ${(buf.length / 1024).toFixed(1)} КБ`);
}
