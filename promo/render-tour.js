// Renders promo/tour.html frame by frame with headless Chrome (DevTools protocol) and
// turns the frames into promo/meet-mixer-tour.mp4 (1920 × 1080) and .gif (720 wide) with ffmpeg.
// Uses a temporary Chrome profile and a temporary frame folder; both are deleted afterwards.
//   node promo/render-tour.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const FPS = 25;
const page = `file:///${path.join(__dirname, 'tour.html').replace(/\\/g, '/')}`;
const outMp4 = path.join(__dirname, 'meet-mixer-tour.mp4');
const outGif = path.join(__dirname, 'meet-mixer-tour.gif');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-mixer-tour-'));
const frames = path.join(work, 'frames');
fs.mkdirSync(frames);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(work, 'profile')}`,
  '--window-size=960,540', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Wait for Chrome's debugging port, then talk to its page.
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: page });
  // Wait until the page has set up its render function and fonts.
  for (let i = 0; i < 50; i++) {
    const r = await send('Runtime.evaluate', { expression: 'typeof window.render === "function" && document.fonts.status === "loaded"', returnByValue: true });
    if (r.result.value) break;
    await sleep(100);
  }
  const seconds = (await send('Runtime.evaluate', { expression: 'window.TOUR_SECONDS', returnByValue: true })).result.value;
  const count = Math.round(seconds * FPS);
  for (let i = 0; i < count; i++) {
    await send('Runtime.evaluate', { expression: `window.render(${i / FPS})` });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(frames, `f${String(i).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
    if (i % 50 === 0) console.log(`frame ${i} / ${count}`);
  }
  ws.close();
}

main()
  .then(() => {
    const input = ['-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png')];
    execFileSync('ffmpeg', [...input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', outMp4], { stdio: 'ignore' });
    execFileSync('ffmpeg', [...input, '-vf',
      'fps=20,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
      '-loop', '0', outGif], { stdio: 'ignore' });
    for (const f of [outMp4, outGif]) console.log(`Wrote ${f} (${Math.round(fs.statSync(f).size / 1024)} KB)`);
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    chrome.kill();
    await sleep(500); // Chrome lets go of its profile folder
    fs.rmSync(work, { recursive: true, force: true });
  });
