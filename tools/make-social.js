'use strict';

/*
 * Renders the repository's social preview card.
 *
 *   npx electron tools/make-social.js
 *
 * GitHub shows this image wherever the repository link is pasted — Reddit, X,
 * Discord, Slack — and 1280×640 is the size it asks for. The card is an HTML
 * file rendered in an offscreen window and captured, which keeps the whole
 * toolchain to what the project already depends on.
 *
 * GitHub has no API for the social preview, so the result still has to be
 * uploaded by hand: Settings → General → Social preview.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const WIDTH = 1280;
const HEIGHT = 640;
const OUT = path.join(__dirname, '..', 'docs', 'social-preview.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    useContentSize: true,
    backgroundColor: '#1b1a19',
    webPreferences: { offscreen: true },
  });

  await win.loadFile(path.join(__dirname, 'social-preview.html'));
  // Let the fonts settle before the capture; a half-laid-out card is worse than
  // a slow build.
  await new Promise((r) => setTimeout(r, 900));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());

  const { width, height } = image.getSize();
  console.log(`${OUT} — ${width}×${height}, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
  app.quit();
});
