'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { chat, decideVision, decideAction, decideQuiz } = require('./deepseek');

const HOME_URL = 'https://onlineweb.zhihuishu.com/onlinestuh5';
const LOGIN_URL = 'https://onlineh5.zhihuishu.com/onlineWeb.html#/entry';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor({ rootDir, config, state, onEvent }) {
    this.rootDir = rootDir;
    this.config = config;
    this.state = state;
    this.onEvent = onEvent;
    this.context = null;
    this.page = null;
    this.logs = [];
    this.status = 'idle';
    this.running = false;
    this.paused = false;
    this.stopRequested = false;
    this.pauseResolver = null;
    this.startedAt = null;
    this.currentCourse = null;
    this.videos = [];
    this.done = Number(state.done || 0);
    this.total = Number(state.total || 0);
    this.screenshotVersion = 0;
    this.lastModel = null;
    this.attention = null;
    this.shotsDir = path.join(rootDir, 'shots');
    fs.mkdirSync(this.shotsDir, { recursive: true });
    this.logFile = path.join(rootDir, 'app.log');
  }

  log(event, extra = {}) {
    const entry = { t: new Date().toISOString(), event, ...extra };
    this.logs.push(entry);
    if (this.logs.length > 900) this.logs.splice(0, this.logs.length - 900);
    try { fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n'); } catch {}
    try { this.onEvent?.(entry); } catch {}
    console.log(JSON.stringify(entry));
  }

  saveState() {
    this.state.done = this.done;
    this.state.total = this.total;
    this.state.videos = this.videos.map((v, i) => ({ i, num: v.num, title: v.title, finished: v.finished }));
    try { fs.writeFileSync(path.join(this.rootDir, 'data', 'state.json'), JSON.stringify(this.state, null, 2)); } catch {}
  }

  safeConfig() {
    return {
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      school: this.config.school,
      account: this.config.account,
      hasKey: Boolean(this.config.apiKey),
      keyTail: this.config.apiKey ? String(this.config.apiKey).slice(-4) : '',
      hasPassword: Boolean(this.config.password),
      headless: Boolean(this.config.headless),
      pageDelayMs: this.config.pageDelayMs || 650,
      quizMode: this.config.quizMode || 'model',
      modelResident: this.config.modelResident !== false,
      visionModel: this.config.visionModel || 'deepseek-flash',
      profileDir: this.config.profileDir,
      studyUrl: this.config.studyUrl || '',
      speed: Number(this.config.speed) || 1
    };
  }

  getStatus() {
    return {
      status: this.status,
      running: this.running,
      paused: this.paused,
      browserReady: Boolean(this.context),
      loggedIn: Boolean(this.loggedIn),
      done: this.done,
      total: this.total || this.videos.length || 0,
      currentCourse: this.currentCourse,
      startedAt: this.startedAt,
      captcha: this.captcha || null,
      attention: this.attention || null,
      screenshotVersion: this.screenshotVersion,
      logs: this.logs.slice(-180),
      config: this.safeConfig(),
      lastModel: this.lastModel
    };
  }

  getCatalog() {
    return this.videos.map((v, i) => ({
      userCourseId: 'v' + i,
      resourceName: v.num + ' ' + v.title,
      categoryName: v.chapter || '课程视频',
      status: v.finished ? 'done' : 'pending'
    }));
  }

  async launch() {
    if (this.context && this.page && !this.page.isClosed()) return this.getStatus();
    fs.mkdirSync(this.config.profileDir, { recursive: true });
    this.log('browser_launch', { profile: this.config.profileDir });
    const channel = this.config.browserChannel || (process.platform === 'win32' ? 'msedge' : '');
    const launchOptions = {
      headless: Boolean(this.config.headless),
      viewport: { width: 1440, height: 1000 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling']
    };
    if (channel) launchOptions.channel = channel;
    this.context = await chromium.launchPersistentContext(this.config.profileDir, launchOptions);
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    await this.gotoStudy();
    await this.detectLogin();
    if (this.loggedIn) await this.prepareCourse();
    this.status = this.loggedIn ? 'ready' : 'login_required';
    await this.capture();
    return this.getStatus();
  }

  async ensurePage() {
    if (!this.context || !this.page || this.page.isClosed()) await this.launch();
    return this.page;
  }

  async ensureStudyPage() {
    if (!this.context) await this.launch();
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const study = pages.find((p) => p.url().includes('studyvideoh5.zhihuishu.com/stuStudy'));
    if (study) { this.page = study; return study; }
    if (!this.page || this.page.isClosed()) this.page = pages[0] || await this.context.newPage();
    await this.gotoStudy();
    return this.page;
  }

  async gotoStudy() {
    if (!this.config.studyUrl) throw new Error('请先在设置里填写课程学习页 URL（studyUrl）');
    await this.page.goto(this.config.studyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => this.log('goto_warn', { msg: e.message }));
    await sleep(5000);
  }

  async detectLogin() {
    const url = this.page.url();
    const body = await this.page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
    this.loggedIn = !url.includes('login.zhihuishu.com') && !/登录中心|学号登录|账号登录/.test(body);
    this.status = this.loggedIn ? 'ready' : 'login_required';
    this.log(this.loggedIn ? 'login_detected' : 'login_required', { url });
    return this.loggedIn;
  }

  async openLogin() {
    await this.ensurePage();
    await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2500);
    this.loggedIn = false;
    this.status = 'login_required';
    this.log('login_opened', { msg: '请在浏览器中登录智慧树，并进入共享课' });
    await this.capture();
  }

  async closeMasks() {
    for (const t of ['下次再说', '不再提示', '知道了', '关闭']) {
      const el = this.page.getByText(t, { exact: true }).first();
      if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        await sleep(500);
        this.log('dismiss_modal', { text: t });
      }
    }
    const maskCount = await this.page.locator('.mask').count().catch(() => 0);
    if (maskCount) {
      await this.page.evaluate(() => document.querySelectorAll('.mask').forEach((e) => e.remove()));
      this.log('remove_mask', { count: maskCount });
    }
    // 学前必读/课程提醒/温馨提示这些信息弹窗会挡住视频列表
    const removed = await this.page.evaluate(() => {
      let n = 0;
      for (const w of document.querySelectorAll('.el-dialog__wrapper')) {
        if (/学前必读|课程提醒|温馨提示|学习指导/.test(w.innerText || '')) { w.remove(); n++; }
      }
      document.querySelectorAll('.v-modal').forEach((e) => e.remove());
      return n;
    }).catch(() => 0);
    if (removed) this.log('remove_info_dialog', { count: removed });
  }

  async prepareCourse() {
    if (!this.page.url().includes('studyvideoh5.zhihuishu.com/stuStudy')) await this.gotoStudy();
    await sleep(3000);
    await this.closeMasks();
    await this.scanVideos();
  }

  async scanVideos() {
    await this.ensureStudyPage();
    const data = await this.page.evaluate(() => {
      return [...document.querySelectorAll('li.video')].map((li, i) => {
        const num = (li.querySelector('.catalogue_title4')?.innerText || '').replace(/\s+/g, ' ').trim();
        const title = (li.querySelector('.catalogue_title')?.innerText || '').replace(/\s+/g, ' ').trim();
        const time = (li.querySelector('.time')?.innerText || '').trim();
        const chapter = (li.closest('.chapter')?.querySelector('.chapter-em')?.innerText || '').trim();
        return { i, num, title, time, chapter, finished: Boolean(li.querySelector('.time_icofinish')), current: li.classList.contains('current_play') };
      });
    });
    this.videos = data;
    this.total = data.length;
    const done = data.filter((v) => v.finished).length;
    this.done = Math.max(this.done, done);
    this.state.videos = data;
    this.saveState();
    this.log('scan_videos', { total: this.total, finished: done, current: data.find((v) => v.current)?.num });
    return data;
  }

  async refreshProgress() {
    await this.ensurePage();
    if (!this.page.url().includes('studyvideoh5.zhihuishu.com/stuStudy')) await this.gotoStudy();
    await sleep(1500);
    await this.closeMasks();
    await this.scanVideos();
    const finished = this.videos.filter((v) => v.finished).length;
    this.done = finished;
    this.saveState();
    return { done: this.done, total: this.total };
  }

  async clickVideo(index) {
    await this.ensureStudyPage();
    await this.closeMasks();
    this.log('click_video_start', { index });
    const expected = this.videos[index]?.title || '';
    const li = this.page.locator('li.video').nth(index);
    // 只点标题，不要点整个 li（li 可能带课程主页链接）
    await li.locator('.catalogue_title').click({ force: true, timeout: 5000 }).catch(() => {});
    await sleep(2000);
    await this.closeMasks();
    let title = await this.page.locator('.videotop_lesson_tit').innerText().catch(() => '');
    if (expected && !title.includes(expected)) {
      this.log('click_video_retry', { index, expected, title });
      await this.page.evaluate((i) => {
        const el = document.querySelectorAll('li.video')[i];
        const t = el && el.querySelector('.catalogue_title');
        if (t) t.click();
      }, index).catch(() => {});
      await sleep(2500);
      await this.closeMasks();
      title = await this.page.locator('.videotop_lesson_tit').innerText().catch(() => '');
    }
    this.log('click_video', { index, expected, title });
    if (expected && !title.includes(expected)) throw new Error('视频没有切换成功：' + expected + ' / ' + title);
    return true;
  }

  async playCurrent(index) {
    await this.ensureStudyPage();
    const v = this.page.locator('video').first();
    await v.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    let info = await v.evaluate((v) => ({ t: v.currentTime, d: v.duration, paused: v.paused, ended: v.ended })).catch(() => null);
    if (!info) throw new Error('视频没有加载出来');
    if (info.d > 0 && info.t >= info.d - 1) { this.log('video_already_done', info); return true; }
    const big = this.page.locator('.vjs-big-play-button').first();
    if (await big.isVisible().catch(() => false)) await big.click().catch(() => {});
    await v.evaluate((v, rate) => { v.playbackRate = rate; return v.play().catch(() => {}); }, Number(this.config.speed) || 1).catch(() => {});
    let lastLog = -1;
    for (let t = 0; t < 7200; t++) {
      await this.checkpoint();
      await sleep(1000);
      if (await this.hasBlockingOverlay()) await this.handleOverlay();
      info = await v.evaluate((v) => ({ t: v.currentTime, d: v.duration, paused: v.paused, ended: v.ended, ready: v.readyState })).catch(() => null);
      if (!info) break;
      if (info.ended || (info.d > 0 && info.t >= info.d - 0.8)) {
        this.log('video_end', { index, t: Math.round(info.t), d: Math.round(info.d) });
        return true;
      }
      if (info.paused && info.ready >= 2) {
        await this.page.locator('.vjs-play-control').first().click({ force: true }).catch(() => {});
        await v.evaluate((v) => v.play().catch(() => {})).catch(() => {});
      }
      const sec = Math.floor(info.t || 0);
      if (sec !== lastLog && sec % 30 === 0) {
        lastLog = sec;
        this.log('video_wait', { index, t: Math.round(info.t), d: Math.round(info.d || 0), paused: info.paused });
        await this.capture().catch(() => {});
      }
    }
    return false;
  }

  async hasBlockingOverlay() {
    const mask = await this.page.locator('.mask').count().catch(() => 0);
    const dialog = await this.page.locator('.el-dialog__wrapper:visible, .dialog-warn:visible, .dialog-quit:visible').count().catch(() => 0);
    const cap = await this.isHumanVerification();
    return Boolean(mask || dialog || cap);
  }

  async pageState() {
    return await this.page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const elements = [...document.querySelectorAll('a,button,input,select,textarea,[onclick],[role="button"],[class*="btn"],[class*="option"],[class*="answer"],[class*="play"],[class*="next"]')]
        .filter((e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 2 && r.height > 2; })
        .slice(0, 70)
        .map((e) => { const r = e.getBoundingClientRect(); return { tag: e.tagName, cls: typeof e.className === 'string' ? e.className.slice(0, 100) : '', text: (e.innerText || e.value || '').trim().slice(0, 80), id: e.id, x: +(((r.left + r.width / 2) / vw).toFixed(3)), y: +(((r.top + r.height / 2) / vh).toFixed(3)) }; });
      return { url: location.href, viewport: { w: vw, h: vh }, bodyText: document.body.innerText.slice(0, 2500), elements };
    });
  }

  async decidePage(state) {
    let decision = null;
    if (this.config.apiKey) {
      try {
        const buf = await this.page.screenshot({ type: 'png' });
        decision = await decideVision({ config: this.config, screenshotBase64: buf.toString('base64'), pageState: state, log: (e, d) => this.log(e, d) });
        if (decision) this.log('vision_decision', { action: decision.action, reason: decision.reason });
      } catch (e) { this.log('vision_error', { msg: e.message }); }
    }
    if (!decision || decision.action === 'report_stuck') decision = await decideAction({ config: this.config, pageState: state, log: (e, d) => this.log(e, d) });
    return decision;
  }

  async executeDecision(d) {
    const vp = this.page.viewportSize() || { width: 1440, height: 1000 };
    if (d.action === 'click_selector' && d.selector) {
      try { await this.page.locator(d.selector).first().click({ timeout: 5000 }); return true; } catch {}
    }
    if (d.action === 'click_at') {
      try { await this.page.mouse.click(Number(d.x) * vp.width, Number(d.y) * vp.height); return true; } catch {}
    }
    if (d.action === 'drag') {
      try {
        await this.page.mouse.move(Number(d.from_x) * vp.width, Number(d.from_y) * vp.height);
        await this.page.mouse.down();
        await this.page.mouse.move(Number(d.to_x) * vp.width, Number(d.to_y) * vp.height, { steps: 20 });
        await this.page.mouse.up();
        return true;
      } catch {}
    }
    if (d.action === 'press_key' && d.key) { await this.page.keyboard.press(String(d.key)).catch(() => {}); return true; }
    if (d.action === 'wait') { await sleep(Math.min(15000, Math.max(200, d.ms || 1000))); return true; }
    if (d.action === 'reload') { await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(2000); return true; }
    return false;
  }

  async isHumanVerification() {
    return await this.page.evaluate(() => {
      const wrap = document.querySelector('#tcaptcha_transform_dy, .tcaptcha-transform, .tcaptcha');
      if (!wrap) return false;
      const s = getComputedStyle(wrap);
      const r = wrap.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.1 && r.width > 50 && r.height > 50 && r.top >= 0;
    }).catch(() => false);
  }

  async waitHuman() {
    this.status = 'waiting_human';
    while (this.status === 'waiting_human' && !this.stopRequested) await sleep(1000);
    this.attention = null;
    if (this.stopRequested) throw Object.assign(new Error('已停止'), { code: 'STOP' });
    this.status = 'running';
    this.log('human_resolved');
    await sleep(1200);
  }

  async handleHumanVerification() {
    this.log('human_verification_detected');
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await this.pageState();
      state.bodyText = (state.bodyText || '') + '\n这是人机验证/滑块拼图，请返回 drag 动作，从滑块拖到缺口。';
      const d = await this.decidePage(state);
      this.lastModel = { at: new Date().toISOString(), kind: 'captcha', decision: d, reason: d.reason };
      this.log('captcha_ai_attempt', { attempt: attempt + 1, decision: d });
      await this.executeDecision(d);
      await sleep(2200);
      if (!(await this.isHumanVerification())) { this.log('captcha_ai_success'); return true; }
    }
    this.attention = { title: '需要人机验证', message: 'AI 尝试未通过，请在浏览器里完成滑块/拼图验证，然后点“我已处理，继续”。', image: '/api/screenshot?v=' + this.screenshotVersion };
    this.log('captcha_human_required');
    await this.waitHuman();
    return true;
  }

  async isQuizPopup() {
    const dlg = this.page.locator('.el-dialog__wrapper:visible, .dialog-warn:visible, .dialog-quit:visible').first();
    let text = '';
    if (await dlg.count().catch(() => 0)) text = await dlg.innerText().catch(() => '');
    if (!text) text = await this.page.locator('body').innerText().catch(() => '');
    if (!/【(判断题|单选题|多选题)】|弹题|请选择|正确答案/.test(text)) return false;
    const n = await this.page.locator('input[type=radio]:visible, input[type=checkbox]:visible, .option:visible, .answer-item:visible, .nodeLab:visible').count().catch(() => 0);
    return n > 0 || /【(判断题|单选题|多选题)】/.test(text);
  }

  async solveQuizPopup() {
    const dlg = this.page.locator('.el-dialog__wrapper:visible, .dialog-warn:visible, .dialog-quit:visible').first();
    const hasDlg = await dlg.count().catch(() => 0);
    const root = hasDlg ? dlg : this.page;
    const text = await root.innerText().catch(() => '');
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    const options = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([A-D])[.、]\s*(.*)$/);
      if (m) {
        let val = m[2].trim();
        if (!val && lines[i + 1]) val = lines[i + 1];
        if (val) options.push(val);
      }
    }
    const labels = root.locator('label');
    const inputs = root.locator('input');
    const n = await inputs.count();
    const inputOptions = [];
    for (let i = 0; i < n; i++) inputOptions.push((await labels.nth(i).innerText().catch(() => '')).trim() || (await inputs.nth(i).getAttribute('value').catch(() => '')) || '');
    const finalOptions = options.length >= 2 ? options : inputOptions;
    const question = lines.filter((x) => !/^[A-D][.、]/.test(x) && !/^(提交|确定|关闭|上一题|下一题)$/.test(x)).join(' ').slice(0, 1200);
    const type = /多选/.test(text) ? 'checkbox' : 'radio';
    this.log('popup_quiz_detected', { question: question.slice(0, 200), options: finalOptions, type });
    if (finalOptions.length >= 2) {
      const decision = await decideQuiz({ config: this.config, question, options: finalOptions, type, log: (e, d) => this.log(e, d) });
      this.lastModel = { at: new Date().toISOString(), kind: 'quiz', question: question.slice(0, 180), options: finalOptions, picked: decision.indexes, reason: decision.reason, source: decision.source };
      this.log('popup_quiz_model', { picked: decision.indexes, source: decision.source, reason: decision.reason });
      for (const i of decision.indexes || []) {
        const val = finalOptions[i];
        if (!val) continue;
        const byText = root.getByText(val, { exact: true }).first();
        if (await byText.count().catch(() => 0)) await byText.click({ force: true }).catch(() => {});
        else {
          const byNode = root.locator('.node_detail, .option, .answer-item, .nodeLab, .label').filter({ hasText: val }).first();
          if (await byNode.count().catch(() => 0)) await byNode.click({ force: true }).catch(() => {});
          else await labels.nth(i).click({ force: true }).catch(() => {});
        }
      }
    } else {
      // 选项是图片/无法从文本提取，交给视觉模型直接点
      const state = await this.pageState();
      state.bodyText = (state.bodyText || '') + '\n这是视频弹题，请选择正确答案并提交。';
      const d = await this.decidePage(state);
      this.lastModel = { at: new Date().toISOString(), kind: 'quiz', question: question.slice(0, 180), options: [], picked: [], reason: d.reason, source: 'vision' };
      this.log('popup_quiz_vision', d);
      await this.executeDecision(d);
    }
    await sleep(600);
    for (const t of ['提交', '确定', '保存', '下一题', '关闭']) {
      const b = root.getByText(t, { exact: true }).first();
      if (await b.count().catch(() => 0) && await b.isVisible().catch(() => false)) { await b.click({ force: true }).catch(() => {}); break; }
    }
    await sleep(1500);
  }

  async handleOverlay() {
    await this.closeMasks();
    if (await this.isHumanVerification()) { await this.handleHumanVerification(); return; }
    if (await this.isQuizPopup()) { await this.solveQuizPopup(); return; }
    if (await this.hasBlockingOverlay()) {
      const state = await this.pageState();
      const d = await this.decidePage(state);
      this.lastModel = { at: new Date().toISOString(), kind: 'action', decision: d, reason: d.reason };
      this.log('overlay_decision', d);
      await this.executeDecision(d);
      await sleep(1200);
    }
  }

  async debugChat(message) {
    await this.ensurePage();
    if (!this.config.apiKey) throw new Error('请先在设置里填写 DeepSeek API Key');
    const state = await this.pageState();
    const logs = this.logs.slice(-25).map((x) => ({ t: x.t, event: x.event, ...Object.fromEntries(Object.entries(x).filter(([k]) => !['t', 'event'].includes(k))) }));
    this.log('debug_user', { message });
    const data = await chat(this.config, [
      { role: 'system', content: '你是智慧树刷课脚本的调试助手。根据当前页面状态和最近日志，回答用户的问题，指出可能的问题和下一步建议。不要假装执行了操作；只做分析。回答用中文，尽量短。' },
      { role: 'user', content: JSON.stringify({ message, page: state, recentLogs: logs }, null, 2) }
    ], null, 60000);
    const answer = data.choices?.[0]?.message?.content || '(模型没有返回内容)';
    this.log('debug_ai', { answer: answer.slice(0, 1200) });
    this.lastModel = { at: new Date().toISOString(), kind: 'debug', question: message.slice(0, 180), reason: answer };
    return { answer };
  }

  async aiStep() {
    await this.ensurePage();
    if (!this.config.apiKey) throw new Error('请先在设置里填写 DeepSeek API Key');
    const state = await this.pageState();
    const d = await this.decidePage(state);
    this.lastModel = { at: new Date().toISOString(), kind: 'action', decision: d, reason: d.reason };
    const ok = await this.executeDecision(d);
    await this.capture();
    return { handled: Boolean(ok), decision: d, status: this.status };
  }

  async start() {
    if (this.running) return this.getStatus();
    this.stopRequested = false;
    this.paused = false;
    this.startedAt = new Date().toISOString();
    this.running = true;
    this.status = 'running';
    this.loopPromise = this.runLoop().catch((e) => {
      this.running = false;
      if (e.code === 'STOP') { this.status = 'stopped'; this.log('stopped'); }
      else if (e.code === 'LOGIN') { this.status = 'login_required'; this.loggedIn = false; this.log('login_required', { msg: e.message }); }
      else { this.status = 'error'; this.log('fatal', { msg: e.message, stack: e.stack }); }
    });
    return this.getStatus();
  }

  async pause() { if (this.running) { this.paused = true; this.status = 'paused'; this.log('paused'); } }
  async resume() { this.paused = false; this.status = 'running'; this.pauseResolver?.(); this.pauseResolver = null; this.log('resumed'); }
  async stop() { this.stopRequested = true; this.paused = false; this.pauseResolver?.(); this.pauseResolver = null; this.log('stop_requested'); }

  async checkpoint() {
    if (this.stopRequested) throw Object.assign(new Error('已停止'), { code: 'STOP' });
    while (this.paused && !this.stopRequested) await new Promise((r) => { this.pauseResolver = r; });
    if (this.stopRequested) throw Object.assign(new Error('已停止'), { code: 'STOP' });
  }

  async runLoop() {
    await this.ensurePage();
    await this.ensureStudyPage();
    if (!this.loggedIn) {
      const ok = await this.detectLogin();
      if (!ok) throw Object.assign(new Error('请先登录智慧树共享课'), { code: 'LOGIN' });
    }
    await this.prepareCourse();
    await this.scanVideos();
    this.log('run_start', { total: this.videos.length, finished: this.videos.filter((v) => v.finished).length });
    for (let i = 0; i < this.videos.length; i++) {
      await this.checkpoint();
      const v = this.videos[i];
      if (v.finished) continue;
      this.currentCourse = { userCourseId: 'v' + i, resourceName: v.num + ' ' + v.title };
      this.status = 'running';
      this.saveState();
      this.log('video_begin', { index: i, num: v.num, title: v.title });
      try {
        await this.clickVideo(i);
        const ended = await this.playCurrent(i);
        if (!ended) throw new Error('视频没有自然播放结束');
        this.videos[i].finished = true;
        this.done = this.videos.filter((x) => x.finished).length;
        this.state.completed = [...new Set([...(this.state.completed || []), 'v' + i])];
        this.saveState();
        this.log('video_done', { index: i, num: v.num, done: this.done, total: this.total });
        await this.capture();
      } catch (e) {
        if (e.code === 'STOP') throw e;
        this.log('video_error', { index: i, num: v.num, msg: e.message });
        throw e;
      }
    }
    this.status = 'done';
    this.running = false;
    this.currentCourse = null;
    this.saveState();
    this.log('all_videos_done', { done: this.done, total: this.total });
  }

  async capture() {
    if (!this.page || this.page.isClosed()) return;
    try { await this.page.screenshot({ path: path.join(this.shotsDir, 'current.png'), fullPage: false }); this.screenshotVersion++; } catch {}
  }

  async testModel() { return require('./deepseek').testConnection(this.config); }
}

module.exports = { Bot };