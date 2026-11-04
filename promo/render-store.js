// Renders promo/store.html to the Chrome Web Store images, at exact store sizes (no scaling):
// store-screenshot.png (1280 × 800) and store-tile.png (440 × 280).
// A temporary profile is used, so the normal Chrome profile is never touched.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const page = `file:///${path.join(__dirname, 'store.html').replace(/\\/g, '/')}`;
const shots = [
  { v: 'shot', size: '1280,800', file: 'store-screenshot.png' },
  { v: 'tile', size: '440,280', file: 'store-tile.png' },
];

for (const shot of shots) {
  const out = path.join(__dirname, shot.file);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-mixer-render-'));
  try {
    execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      `--user-data-dir=${profile}`, `--window-size=${shot.size}`, '--force-device-scale-factor=1',
      `--screenshot=${out}`, `${page}?v=${shot.v}`,
    ], { stdio: 'ignore', timeout: 60000 });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(`Wrote ${out}`);
}
