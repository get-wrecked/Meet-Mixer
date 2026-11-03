// Renders promo/ad.html to promo/meet-mixer-ad.png (2400 × 1256) with Chrome in headless mode.
// A temporary profile is used, so the normal Chrome profile is never touched.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const page = path.join(__dirname, 'ad.html');
const out = path.join(__dirname, 'meet-mixer-ad.png');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-mixer-render-'));

try {
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${profile}`, '--window-size=1200,628', '--force-device-scale-factor=2',
    `--screenshot=${out}`, `file:///${page.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore', timeout: 60000 });
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(`Wrote ${out}`);
