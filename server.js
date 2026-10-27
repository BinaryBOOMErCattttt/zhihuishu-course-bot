'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Bot } = require('./lib/bot');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4319);
const HOST = process.env.HOST || '127.0.0.1';
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const PUBLIC = path.join(ROOT, 'public');
const SHOTS = path.join(ROOT, 'shots');

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const defaultConfig = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  school: '',
  account: '',
  password: '',
  profileDir: path.join(ROOT, 'profile'),
  speed: 1.5,
  headless: false,
  pageDelayMs: 650,
  quizMode: 'model',
  modelResident: true,
  visionModel: 'deepseek-flash',
  studyUrl: '',
  browserChannel: process.platform === 'win32' ? 'msedge' : '',
  autoDebug: true,
  agentMemoryRounds: 2
};

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let config = { ...defaultConfig, ...loadJson(CONFIG_PATH, {}) };
if (process.env.DEEPSEEK_API_KEY) config.apiKey = process.env.DEEPSEEK_API_KEY;
if (process.env.STUDY_URL) config.studyUrl = process.env.STUDY_URL;
if (process.env.BROWSER_CHANNEL !== undefined) config.browserChannel = process.env.BROWSER_CHANNEL;
if (process.env.PROFILE_DIR) config.profileDir = process.env.PROFILE_DIR;
if (process.env.HEADLESS !== undefined) config.headless = String(process.env.HEADLESS).toLowerCase() === 'true';
if (process.env.SPEED) config.speed = Number(process.env.SPEED) || 1.5;
let state = loadJson(STATE_PATH, { completed: [], done: 0, current: null });
if (!Array.isArray(state.completed)) state.completed = [];

const bot = new Bot({
  rootDir: ROOT,
  config,
  state,
  onEvent: () => {}
});

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function text(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function body(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function file(res, filePath, type) {
  if (!fs.existsSync(filePath)) return text(res, 404, 'not found');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function safeJoin(base, p) {
  const target = path.resolve(base, '.' + p);
  return target.startsWith(path.resolve(base)) ? target : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p === '/api/state' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...bot.getStatus(), catalog: bot.getCatalog() });
    }
    if (p === '/api/config' && req.method === 'GET') {
      return json(res, 200, { ok: true, config: { ...bot.safeConfig(), profileDir: bot.config.profileDir }, hasKey: Boolean(bot.config.apiKey), hasPassword: Boolean(bot.config.password) });
    }
    if (p === '/api/config' && req.method === 'POST') {
      const b = await body(req);
      const next = { ...bot.config };
      for (const key of ['baseUrl', 'model', 'school', 'account', 'password', 'profileDir', 'headless', 'pageDelayMs', 'apiKey', 'quizMode', 'modelResident', 'visionModel', 'speed', 'studyUrl', 'browserChannel', 'autoDebug', 'agentMemoryRounds']) {
        if (Object.prototype.hasOwnProperty.call(b, key)) {
          if (key === 'apiKey' && /^\*+$/.test(String(b[key] || ''))) continue;
          next[key] = b[key];
        }
      }
      next.pageDelayMs = Math.max(200, Math.min(5000, Number(next.pageDelayMs) || 650));
      next.headless = Boolean(next.headless);
      config = next;
      bot.config = next;
      saveJson(CONFIG_PATH, next);
      return json(res, 200, { ok: true, config: { ...bot.safeConfig(), profileDir: next.profileDir } });
    }
    if (p === '/api/test-model' && req.method === 'POST') {
      try { const r = await bot.testModel(); return json(res, 200, { ok: true, message: r }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/browser/launch' && req.method === 'POST') {
      try { const s = await bot.launch(); return json(res, 200, { ok: true, state: s }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/login' && req.method === 'POST') {
      try { await bot.openLogin(); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/login/wait' && req.method === 'POST') {
      try { await bot.waitForLogin(); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/start' && req.method === 'POST') {
      try { const s = await bot.start(); return json(res, 200, { ok: true, state: s }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/pause' && req.method === 'POST') { await bot.pause(); return json(res, 200, { ok: true }); }
    if (p === '/api/resume' && req.method === 'POST') { await bot.resume(); return json(res, 200, { ok: true }); }
    if (p === '/api/stop' && req.method === 'POST') { await bot.stop(); return json(res, 200, { ok: true }); }
    if (p === '/api/refresh' && req.method === 'POST') {
      try { const r = await bot.refreshProgress(); await bot.capture(); return json(res, 200, { ok: true, ...r }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/debug/chat' && req.method === 'POST') {
      try {
        const b = await body(req);
        const r = await bot.debugChat(String(b.message || ''));
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }
    if (p === '/api/reload' && req.method === 'POST') {
      try {
        for (const key of Object.keys(require.cache)) {
          if (key.endsWith('lib\\bot.js') || key.endsWith('lib\\deepseek.js')) delete require.cache[key];
        }
        const NewBot = require('./lib/bot').Bot;
        let count = 0;
        for (const name of Object.getOwnPropertyNames(NewBot.prototype)) {
          if (name === 'constructor') continue;
          bot[name] = NewBot.prototype[name];
          count++;
        }
        return json(res, 200, { ok: true, methods: count, browserReady: Boolean(bot.context), url: bot.page?.url?.() });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }
    if (p === '/api/ai/step' && req.method === 'POST') {
      try {
        const wasRunning = bot.running;
        if (wasRunning) {
          await bot.pause();
          await new Promise((r) => setTimeout(r, 900));
        }
        const result = await bot.aiStep();
        return json(res, 200, { ok: true, ...result, wasRunning });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }
    if (p === '/api/attention/ack' && req.method === 'POST') {
      bot.attention = null;
      if (bot.status === 'waiting_human') bot.status = 'running';
      return json(res, 200, { ok: true });
    }
    if (p === '/api/captcha' && req.method === 'POST') {
      try { const b = await body(req); const r = await bot.submitCaptcha(b.points || []); return json(res, 200, { ok: true, ...r }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/debug' && req.method === 'GET') {
      if (!bot.page) return json(res, 200, { ok: true, page: null, frames: [] });
      const frames = [];
      for (const f of bot.page.frames()) {
        const item = { url: f.url() };
        try {
          item.pages = await f.locator('section.page-item').count();
          item.active = await f.locator('section.page-active').count();
          item.videos = await f.locator('video').count();
          item.body = (await f.locator('body').innerText()).slice(0, 1200);
          item.html = (await f.locator('body').innerHTML()).slice(0, 2500);
        } catch (e) { item.error = e.message; }
        frames.push(item);
      }
      return json(res, 200, { ok: true, page: bot.page.url(), frames });
    }
    if (p === '/api/debug/open' && req.method === 'POST') {
      const b = await body(req);
      const c = bot.getCatalog().find((x) => x.userCourseId === b.userCourseId);
      if (!c) return json(res, 404, { ok: false, error: 'course not found' });
      try {
        const f = await bot.openCourse(c);
        bot.frame = f;
        await bot.capture();
        return json(res, 200, { ok: true, url: f.url() });
      } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/debug/advance' && req.method === 'POST') {
      const b = await body(req);
      const frame = bot.frame || bot.page?.frames().find((f) => f.url().includes('mcwk.mycourse.cn'));
      if (!frame) return json(res, 400, { ok: false, error: 'no course frame' });
      try {
        const start = frame.locator('.btn-start').first();
        if (await start.isVisible().catch(() => false)) { await start.click().catch(() => {}); await new Promise((r) => setTimeout(r, 1200)); }
        const count = Math.max(0, Math.min(80, Number(b.count) || 0));
        for (let i = 0; i < count; i++) {
          const active = frame.locator('section.page-active');
          const next = active.locator('.btn-next').first();
          if (!(await next.count())) break;
          await next.click().catch(() => {});
          await new Promise((r) => setTimeout(r, 700));
        }
        const cls = await frame.locator('section.page-active').getAttribute('class').catch(() => '');
        await bot.capture();
        return json(res, 200, { ok: true, cls });
      } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/api/screenshot') return file(res, path.join(SHOTS, 'current.png'), 'image/png');
    if (p === '/api/captcha-image') return file(res, path.join(SHOTS, 'captcha.png'), 'image/png');
    if (p === '/api/logs') return json(res, 200, { ok: true, logs: bot.logs.slice(-300) });

    // static
    let pathname = p === '/' ? '/index.html' : p;
    const target = safeJoin(PUBLIC, pathname);
    if (!target) return text(res, 403, 'forbidden');
    return file(res, target, mime(target));
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  const url = 'http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT;
  console.log('');
  console.log('  智慧树刷课助手');
  console.log('  GUI: ' + url);
  console.log('  按 Ctrl+C 退出');
  console.log('');
  if (process.platform === 'win32') {
    setTimeout(() => exec('start "" "' + url + '"'), 400);
  }
});

process.on('SIGINT', async () => {
  console.log('\n正在退出...');
  try { await bot.stop(); } catch {}
  try { if (bot.context) await bot.context.close(); } catch {}
  process.exit(0);
});