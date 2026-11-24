'use strict';

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chat, decideVision, decideAction, decideQuiz, decideQuizVision, decideCaptchaVision } = require('./deepseek');

// 学习页地址：由 config.studyUrl 提供，不再硬编码课程 ID
const DEFAULT_STUDY_URL = 'https://studyvideoh5.zhihuishu.com/';
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
    this.lastError = null;
    this.errorCount = 0;
    this.autoHealAttempts = new Map();
    this.lastHeal = null;
    this.inIncident = false;
    this.incidentTimer = null;
    this.pendingIncident = null;
    this.incidentDir = path.join(rootDir, 'data', 'incidents');
    this.captchaSolving = false;
    this.examRunning = false;
    this.lastActivity = Date.now();
    this.loginWatch = null;
    this.watchdog = null;
    this.shotsDir = path.join(rootDir, 'shots');
    fs.mkdirSync(this.shotsDir, { recursive: true });
    this.logFile = path.join(rootDir, 'app.log');
    this.catalogPath = path.join(rootDir, 'data', 'videos.json');
    this.timerPath = path.join(rootDir, 'data', 'timer.json');
    this.ensureTimer();
    this.startIndex = null;
    this.pluginsDir = path.join(rootDir, 'data', 'plugins');
    this.patchesPath = path.join(rootDir, 'data', 'patches.json');
    this.agentMemoryPath = path.join(rootDir, 'data', 'agent-memory.json');
    this.quizBankPath = (config && config.bankPath) ? path.resolve(rootDir, config.bankPath) : path.join(rootDir, 'data', 'quiz-bank.json');
    this.ensureQuizBank();
    this.agentMemoryRounds = Math.max(1, Math.min(10, Number(config.agentMemoryRounds) || 2));
    try { this.agentMemory = JSON.parse(fs.readFileSync(this.agentMemoryPath, 'utf8')); } catch { this.agentMemory = []; }
    if (!Array.isArray(this.agentMemory)) this.agentMemory = [];
    this.applyStoredPatches();
  }

  ensureRuntimeState() {
    if (!this.autoHealAttempts) this.autoHealAttempts = new Map();
    if (!this.pluginsDir) this.pluginsDir = path.join(this.rootDir, 'data', 'plugins');
    if (!this.patchesPath) this.patchesPath = path.join(this.rootDir, 'data', 'patches.json');
    if (!this.incidentDir) this.incidentDir = path.join(this.rootDir, 'data', 'incidents');
    if (!this.agentMemoryPath) this.agentMemoryPath = path.join(this.rootDir, 'data', 'agent-memory.json');
    if (!Array.isArray(this.agentMemory)) this.agentMemory = [];
    if (!this.agentMemoryRounds) this.agentMemoryRounds = Math.max(1, Math.min(10, Number(this.config.agentMemoryRounds) || 2));
    if (!this.agentMemory.length) {
      try { this.agentMemory = JSON.parse(fs.readFileSync(this.agentMemoryPath, 'utf8')); } catch {}
      if (!Array.isArray(this.agentMemory)) this.agentMemory = [];
    }
  }

  memoryContext() {
    this.ensureRuntimeState();
    return this.agentMemory.slice(-this.agentMemoryRounds);
  }

  applyStoredPatches() {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(this.patchesPath, 'utf8')); } catch { return; }
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (!p || !/^[a-zA-Z_$][\w$]*$/.test(p.method) || p.method === 'constructor' || typeof p.code !== 'string') continue;
      try {
        const fn = new Function('return async function(...args){' + p.code + '}')();
        this[p.method] = fn;
        this.log('patch_applied', { method: p.method, at: p.at });
      } catch (e) {
        this.log('patch_apply_error', { method: p.method, msg: e.message });
      }
    }
  }

  rememberAgentTurn(entry) {
    this.ensureRuntimeState();
    this.agentMemory.push({ at: new Date().toISOString(), ...entry });
    if (this.agentMemory.length > this.agentMemoryRounds) this.agentMemory = this.agentMemory.slice(-this.agentMemoryRounds);
    try { fs.writeFileSync(this.agentMemoryPath, JSON.stringify(this.agentMemory, null, 2)); } catch {}
  }

  log(event, extra = {}) {
    this.lastActivity = Date.now();
    const bad = /error|failed|fatal|stuck|missing|timeout|not_answered|no_close|video_changed|video_rewound|checkmark_missing/i.test(event);
    const entry = { t: new Date().toISOString(), event, ...extra };
    if (bad) {
      entry.level = 'error';
      this.errorCount++;
      this.lastError = { at: entry.t, event, message: extra.msg || extra.error || extra.reason || JSON.stringify(extra).slice(0, 500), count: this.errorCount };
      try {
        fs.mkdirSync(path.join(this.rootDir, 'data'), { recursive: true });
        fs.appendFileSync(path.join(this.rootDir, 'data', 'errors.jsonl'), JSON.stringify(entry) + '\n');
      } catch {}
      if (this.config.alertWebhook) {
        setTimeout(() => fetch(this.config.alertWebhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'Zhihuishu bot error: ' + event + ' ' + (this.lastError?.message || ''), entry })
        }).catch(() => {}), 0);
      }
    }
    this.logs.push(entry);
    if (this.logs.length > 900) this.logs.splice(0, this.logs.length - 900);
    try { fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n'); } catch {}
    try { this.onEvent?.(entry); } catch {}
    if (bad && !this.inIncident && !/^auto_|^incident_|^captcha_|^message_box_|^popup_/.test(event)) {
      this.pendingIncident = entry;
      if (!this.incidentTimer) {
        this.incidentTimer = setTimeout(() => {
          this.incidentTimer = null;
          this.runIncident().catch((e) => this.log('incident_error', { msg: e.message }));
        }, 1200);
      }
    }
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
      speed: Number(this.config.speed) || 1,
      dailyLimitSeconds: Number(this.config.dailyLimitSeconds) || 1200,
      agentMemoryRounds: this.agentMemoryRounds,
      profileDir: this.config.profileDir
    };
  }

  todayKey() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  }

  ensureTimer() {
    const today = this.todayKey();
    let t = null;
    try { t = JSON.parse(fs.readFileSync(this.timerPath, 'utf8')); } catch {}
    if (!t || t.date !== today) t = { date: today, seconds: 0, limit: Math.max(60, Number(this.config.dailyLimitSeconds) || 1500), notified: false };
    t.limit = Math.max(60, Number(this.config.dailyLimitSeconds) || t.limit || 1500);
    t.seconds = Math.max(0, Number(t.seconds) || 0);
    t.notified = Boolean(t.notified);
    this.timer = t;
    try { fs.writeFileSync(this.timerPath, JSON.stringify(t, null, 2)); } catch {}
    return t;
  }

  timerStatus() {
    const t = this.ensureTimer();
    return { date: t.date, seconds: t.seconds, limit: t.limit, remaining: Math.max(0, t.limit - t.seconds), percent: Math.min(100, Math.round((t.seconds / t.limit) * 100)), notified: t.notified };
  }

  addWatchTime(seconds = 1) {
    const t = this.ensureTimer();
    t.seconds += seconds;
    try { fs.writeFileSync(this.timerPath, JSON.stringify(t, null, 2)); } catch {}
    if (t.seconds >= t.limit && !t.notified) {
      t.notified = true;
      try { fs.writeFileSync(this.timerPath, JSON.stringify(t, null, 2)); } catch {}
      this.status = 'daily_limit';
      this.attention = { title: '今日 25 分钟已完成', message: '今天已达到 25 分钟学习时长，脚本已停止。你可以选择继续观看。', image: '/api/screenshot?v=' + this.screenshotVersion };
      this.log('daily_limit_reached', { seconds: t.seconds, limit: t.limit });
      throw Object.assign(new Error('今日学习时长已达到 25 分钟'), { code: 'DAILY_LIMIT' });
    }
    return this.timerStatus();
  }

  async clearProgress(index) {
    await this.ensurePage();
    await this.scanVideos();
    const v = this.videos[index];
    if (!v) throw new Error('没有这节课');
    const key = v.key || ('v' + index);
    this.state.completed = (this.state.completed || []).filter((k) => k !== key);
    this.state.forcePending = [...new Set([...(this.state.forcePending || []), key])];
    v.finished = false;
    this.saveState();
    this.log('progress_cleared', { index, key, title: v.title });
    return { ok: true, index, key, title: v.title };
  }

  async startAt(index) {
    if (!Number.isInteger(index)) throw new Error('起始课程无效');
    if (this.running) { await this.stop(); for (let k = 0; k < 30 && this.running; k++) await sleep(500); }
    const v = this.videos[index];
    if (!v) throw new Error('没有这节课');
    this.startIndex = index;
    this.state.forcePending = [...new Set([...(this.state.forcePending || []), v.key || ('v' + index)])];
    this.saveState();
    this.log('start_at', { index, title: v.title, key: v.key });
    return this.start();
  }

  ensureQuizBank() {
    if (!this.quizBankPath) this.quizBankPath = (this.config && this.config.bankPath) ? path.resolve(this.rootDir, this.config.bankPath) : path.join(this.rootDir, 'data', 'quiz-bank.json');
    fs.mkdirSync(path.dirname(this.quizBankPath), { recursive: true });
    let bank = null;
    try { bank = JSON.parse(fs.readFileSync(this.quizBankPath, 'utf8')); } catch {}
    if (!bank || typeof bank !== 'object') bank = { popup: {}, chapter: {} };
    if (!bank.popup) bank.popup = {};
    if (!bank.chapter) bank.chapter = {};
    this.quizBank = bank;
    return bank;
  }

  normalizeQuizQuestion(question) {
    return String(question || '')
      .replace(/AI助教小智[sS]*?成绩。?/g, '')
      .replace(/^[sS]*?【(判断题|单选题|多选题)】/, '【$1】')
      .replace(/正确答案[:：]s*[A-D]/g, '')
      .replace(/\s+/g, '')
      .replace(/[，。！？、；：,.!?;:'"“”‘’（）()\[\]【】]/g, '')
      .trim();
  }

  quizBankId(question, type, options) {
    const opts = (options || []).map((o) => this.normalizeQuizQuestion(o)).sort().join('|');
    return crypto.createHash('sha1').update((type || 'radio') + '|' + this.normalizeQuizQuestion(question) + '|' + opts).digest('hex');
  }

  currentExamId() {
    const m = String(this.page?.url?.() || '').match(/dohomework\/([^#?]+)/);
    return m ? m[1].replace(/\/0$/, '') : '';
  }

  lookupExamAnswer(examId, index, options, type) {
    const bank = this.ensureQuizBank();
    const eid = String(examId || '').replace(/\/0$/, '');
    const entry = Object.values(bank.chapter || {}).find((x) => String(x.examId || '').replace(/\/0$/, '') === eid && Number(x.examIndex) === Number(index));
    if (!entry) return null;
    const opts = options || [];
    const indexes = (entry.answers || []).map((a) => opts.findIndex((o) => this.normalizeQuizQuestion(o) === this.normalizeQuizQuestion(a))).filter((i) => i >= 0);
    if (!indexes.length) return null;
    return { indexes, reason: '章节题库按题号命中', source: 'bank' };
  }

  lookupQuiz(category, question, options, type) {
    const bank = this.ensureQuizBank();
    const id = this.quizBankId(question, type, options);
    let entry = bank[category]?.[id];
    if (!entry) {
      const want = (options || []).map((o) => this.normalizeQuizQuestion(o)).sort().join('|');
      entry = Object.values(bank[category] || {}).find((x) => (x.options || []).map((o) => this.normalizeQuizQuestion(o)).sort().join('|') === want && (x.type || 'radio') === (type || 'radio'));
    }
    if (!entry) return null;
    const opts = options || [];
    const answers = entry.answers || [];
    const indexes = [];
    for (const a of answers) {
      const i = opts.findIndex((o) => this.normalizeQuizQuestion(o) === this.normalizeQuizQuestion(a));
      if (i >= 0) indexes.push(i);
    }
    const use = indexes.length ? indexes : (entry.indexes || []).filter((i) => Number.isInteger(i) && i >= 0 && i < opts.length);
    if (!use.length) return null;
    return { indexes: use, reason: '题库命中', source: 'bank' };
  }

  saveQuizAnswer(category, question, options, type, indexes, meta = {}) {
    const bank = this.ensureQuizBank();
    const eid = String(meta.examId || '').replace(/\/0$/, '');
    const id = (eid && meta.examIndex !== undefined && meta.examIndex !== null) ? (eid + '#' + meta.examIndex) : this.quizBankId(question, type, options);
    const chosen = (indexes || []).map((i) => options?.[i]).filter(Boolean);
    bank[category][id] = {
      question: String(question || '').slice(0, 2000),
      options: options || [],
      type: type || 'radio',
      indexes: indexes || [],
      answers: chosen,
      examId: meta.examId || '',
      examIndex: meta.examIndex === undefined ? null : meta.examIndex,
      updatedAt: new Date().toISOString(),
      source: meta.source || 'runtime'
    };
    try { fs.writeFileSync(this.quizBankPath, JSON.stringify(bank, null, 2)); } catch {}
    this.log('quiz_bank_saved', { category, id, answers: chosen });
  }

  getStatus() {
    return {
      status: this.status,
      running: this.running,
      paused: this.paused,
      browserReady: Boolean(this.context),
      loggedIn: Boolean(this.loggedIn),
      done: this.done,
      total: this.total || this.videos.length || 62,
      currentCourse: this.currentCourse,
      timer: this.timerStatus(),
      startedAt: this.startedAt,
      captcha: this.captcha || null,
      attention: this.attention || null,
      screenshotVersion: this.screenshotVersion,
      logs: this.logs.slice(-180),
      config: this.safeConfig(),
      lastModel: this.lastModel,
      lastError: this.lastError,
      errorCount: this.errorCount
    };
  }

  getCatalog() {
    return this.videos.map((v, i) => ({
      userCourseId: v.key || ('v' + i),
      index: i,
      forced: (this.state.forcePending || []).includes(v.key || ('v' + i)),
      resourceName: v.num + ' ' + v.title,
      categoryName: v.chapter || '课程视频',
      status: v.finished ? 'done' : 'pending'
    }));
  }

  pageRegistry() {
    if (!this.pages) this.pages = [];
    if (!this.openerMap) this.openerMap = new Map();
    return this.pages;
  }

  registerPage(page, meta = {}) {
    this.pageRegistry();
    let rec = this.pages.find((x) => x.page === page);
    if (!rec) {
      this.pageSeq = (this.pageSeq || 0) + 1;
      rec = { id: 'p' + this.pageSeq, page, bornAt: new Date().toISOString(), parentId: meta.parentId || null, label: meta.label || '' };
      this.pages.push(rec);
    }
    if (meta.label) rec.label = meta.label;
    rec.url = page.isClosed() ? '(closed)' : page.url();
    rec.closed = page.isClosed();
    rec.updatedAt = new Date().toISOString();
    return rec;
  }

  async pageTree() {
    const ctx = this.context;
    if (!ctx) return { pages: [], current: null, note: 'browser not launched' };
    const live = ctx.pages();
    this.pageRegistry();
    // 补齐未登记页面
    for (const pg of live) this.registerPage(pg);
    // 清理已关闭
    this.pages = this.pages.filter((x) => !x.page.isClosed() || x.keep);
    const seenIds = new Set();
    for (const rec of this.pages) {
      if (seenIds.has(rec.id)) { this.pageSeq = (this.pageSeq || 0) + 1; rec.id = 'p' + this.pageSeq; }
      seenIds.add(rec.id);
    }
    const rows = [];
    for (const rec of this.pages) {
      if (rec.page.isClosed()) { rec.closed = true; rec.url = '(closed)'; }
      let title = '';
      try { title = rec.page.isClosed() ? '' : await rec.page.title(); } catch {}
      let kind = 'other';
      const u = rec.url || '';
      if (u.includes('/dohomework/')) kind = 'exam-answering';
      else if (u.includes('/checkHomework/')) kind = 'exam-review';
      else if (u.includes('webExamList')) kind = 'exam-list';
      else if (u.includes('stuStudy')) kind = 'study';
      rows.push({
        id: rec.id,
        kind,
        current: rec.page === this.page,
        closed: rec.closed,
        url: u,
        title: title.slice(0, 40),
        parentId: rec.parentId,
        bornAt: rec.bornAt,
        label: rec.label
      });
    }
    return { current: rows.find((x) => x.current)?.id || null, pages: rows, total: rows.length };
  }

  async focusPageById(id) {
    const rec = this.pageRegistry().find((x) => x.id === id);
    if (!rec || rec.page.isClosed()) return { ok: false, error: 'page not alive: ' + id, tree: await this.pageTree() };
    this.page = rec.page;
    this.page.setDefaultTimeout(15000);
    await this.page.bringToFront().catch(() => {});
    const url = this.page.url();
    const kind = url.includes('/dohomework/') ? 'exam-answering' : url.includes('/checkHomework/') ? 'exam-review' : url.includes('webExamList') ? 'exam-list' : url.includes('stuStudy') ? 'study' : 'other';
    this.log('page_focus', { id, kind, url });
    return { ok: true, id, kind, url, tree: await this.pageTree() };
  }

  async closePageById(id) {
    const rec = this.pageRegistry().find((x) => x.id === id);
    if (!rec) return { ok: false, error: 'unknown page id: ' + id };
    if (rec.page === this.page) return { ok: false, error: '拒绝关闭当前工作页，先 focus 到别的页', tree: await this.pageTree() };
    if (rec.page.isClosed()) { rec.closed = true; return { ok: true, already: true, tree: await this.pageTree() }; }
    const live = this.context?.pages() || [];
    if (live.length <= 1) return { ok: false, error: '只剩一个标签页，关闭会丢登录态', tree: await this.pageTree() };
    const url = rec.page.url();
    await rec.page.close().catch(() => {});
    rec.closed = true;
    this.log('page_closed', { id, url });
    return { ok: true, id, url, tree: await this.pageTree() };
  }

  safeEntryUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return { ok: false, error: 'empty url' };
    // 考试列表 SPA 裸路由：必须带 recruitId 才能渲染，且最稳的是从学习页点进去
    const isBareExamList = /webExamList(\?|#|$)/.test(raw) && !/dohomework|checkHomework/.test(raw) && !/recruitId=/.test(raw);
    if (isBareExamList) return { ok: false, error: '裸路由 #/webExamList 不带 recruitId 会渲染空白，请从课程学习页点“作业考试”，或改用带 recruitId 的完整地址' };
    return { ok: true, url: raw };
  }

  async launch() {
    if (this.context && this.page && !this.page.isClosed()) return this.getStatus();
    fs.mkdirSync(this.config.profileDir, { recursive: true });
    this.log('browser_launch', { profile: this.config.profileDir });
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      channel: 'msedge',
      headless: Boolean(this.config.headless),
      viewport: { width: 1440, height: 1000 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling']
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    this.pageRegistry();
    this.registerPage(this.page, { label: 'main' });
    this.context.on('page', (pg) => {
      this.registerPage(pg);
      this.log('page_opened', { url: pg.url() });
      pg.on('close', () => this.log('page_closed_event', { url: (() => { try { return pg.url(); } catch { return '(gone)'; } })() }));
    });
    await this.gotoStudy();
    await this.detectLogin();
    if (this.loggedIn) await this.prepareCourse();
    else this.startLoginWatch();
    this.status = this.loggedIn ? 'ready' : 'login_required';
    await this.capture();
    return this.getStatus();
  }

  async ensurePage() {
    // 上下文还活着就绝不重开浏览器：只在现有标签页里挑一个活的
    if (this.context) {
      if (this.page && !this.page.isClosed()) return this.page;
      const live = this.context.pages().filter((x) => !x.isClosed());
      if (live.length) {
        this.page = live[0];
        this.page.setDefaultTimeout(15000);
        this.registerPage(this.page, { label: 'revived' });
        this.log('page_revived', { url: this.page.url() });
        return this.page;
      }
      // 全部关掉了：在同一个 context 里新开一页，不重启浏览器
      const np = await this.context.newPage().catch(() => null);
      if (np) {
        this.page = np;
        this.page.setDefaultTimeout(15000);
        this.registerPage(np, { label: 'new' });
        this.log('page_created', {});
        return this.page;
      }
    }
    await this.launch();
    return this.page;
  }

  isStudyUrl(u) {
    const base = String(this.config.studyUrl || '').split('?')[0];
    if (!base) return /zhihuishu\.com/.test(String(u || '')) && /stuStudy/.test(String(u || ''));
    return String(u || '').startsWith(base) || String(u || '').includes(new URL(base).pathname);
  }

  async ensureStudyPage() {
    if (!this.context) await this.launch();
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const study = pages.find((p) => this.isStudyUrl(p.url()));
    if (study) { this.page = study; return study; }
    if (!this.page || this.page.isClosed()) this.page = pages[0] || await this.context.newPage();
    await this.gotoStudy();
    if (this.page.url().includes('login.zhihuishu.com')) throw Object.assign(new Error('请先登录智慧树共享课'), { code: 'LOGIN' });
    return this.page;
  }

  async gotoStudy() {
    const url = this.config.studyUrl || DEFAULT_STUDY_URL;
    if (!this.config.studyUrl) this.log('study_url_missing', { msg: 'config.studyUrl 未配置，仅打开站点首页' });
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => this.log('goto_warn', { msg: e.message }));
    await sleep(5000);
  }

  startLoginWatch() {
    if (this.loginWatch) clearInterval(this.loginWatch);
    this.loginWatch = setInterval(async () => {
      if (this.loggedIn || this.running || this.loginChecking) return;
      this.loginChecking = true;
      try {
        for (const p of this.context?.pages() || []) {
          if (p.isClosed()) continue;
          const url = p.url();
          if (!url.includes('zhihuishu.com')) continue;
          if (/login|passport|oauth|sso/i.test(url)) continue;
          const body = await p.locator('body').innerText({ timeout: 4000 }).catch(() => '');
          if (/登录中心|学号登录|账号登录|扫码登录/.test(body)) continue;
          if (!/我的课程|共享课|课程学习|在线学堂|我的学堂/.test(body)) continue;
          this.page = p;
          this.page.setDefaultTimeout(15000);
          try {
            await this.ensureStudyPage();
            const nowUrl = this.page.url();
            if (!this.isStudyUrl(nowUrl)) throw new Error('还没有进入学习页');
            const nowBody = await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
            if (!/课程|视频|目录/.test(nowBody)) throw new Error('学习页还没有加载出课程目录');
            this.loggedIn = true;
            await this.prepareCourse();
            await this.capture();
            this.status = 'ready';
            this.log('login_success');
            clearInterval(this.loginWatch);
            this.loginWatch = null;
            break;
          } catch (e) {
            this.loggedIn = false;
            this.status = 'login_required';
            this.log('login_wait_course', { msg: e.message, url: this.page.url() });
          }
        }
      } catch {}
      this.loginChecking = false;
    }, 3000);
  }

  async detectLogin() {
    const url = this.page.url();
    const body = await this.page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
    const onLogin = /login|passport|oauth|sso/i.test(url) || /登录中心|学号登录|账号登录|扫码登录/.test(body);
    this.loggedIn = !onLogin;
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
    this.startLoginWatch();
    this.log('login_opened', { msg: '请在浏览器中登录智慧树，并进入共享课' });
    await this.capture();
  }

  async closeMasks() {
    for (const t of ['下次再说', '不再提示', '知道了']) {
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
      for (const w of document.querySelectorAll('.ss2077-custom-dialog, .ss2077-msg-bg, [class*="custom-dialog"]')) {
        if (/学习进度|同学|每日6点/.test(w.innerText || '')) { w.remove(); n++; }
      }
      document.querySelectorAll('.v-modal').forEach((e) => e.remove());
      return n;
    }).catch(() => 0);
    if (removed) this.log('remove_info_dialog', { count: removed });
  }

  async recoverToStudy(reason) {
    this.log('recover_to_study', { reason, url: this.page?.url?.() });
    try {
      const pages = this.context?.pages() || [];
      const study = pages.find((p) => !p.isClosed() && this.isStudyUrl(p.url()));
      if (study) this.page = study;
      else await this.gotoStudy();
      if (this.page.url().includes('login.zhihuishu.com')) {
        this.loggedIn = false;
        this.status = 'login_required';
        this.startLoginWatch();
        return false;
      }
      this.loggedIn = true;
      await this.prepareCourse();
      this.status = this.running ? 'running' : 'ready';
      return true;
    } catch (e) {
      this.log('recover_failed', { msg: e.message });
      return false;
    }
  }

  startWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(async () => {
      if (!this.running || this.paused || this.stopRequested) return;
      if (Date.now() - this.lastActivity < 60000) return;
      this.log('watchdog_stuck', { url: this.page?.url?.() });
      const ok = await this.recoverToStudy('watchdog_no_activity');
      this.lastActivity = Date.now();
      if (!ok) {
        this.attention = { title: '脚本需要人工处理', message: '页面丢失/跳到了首页，自动回到课程页失败，请手动打开课程学习页后点继续。', image: '/api/screenshot?v=' + this.screenshotVersion };
        this.status = 'waiting_human';
      }
    }, 10000);
  }

  async prepareCourse() {
    if (!this.isStudyUrl(this.page.url())) await this.gotoStudy();
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
        const check = li.querySelector('.time_icofinish');
        const half = li.querySelector('.time_ico_half');
        const visible = (el) => {
          if (!el) return false;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01 && r.width > 0 && r.height > 0;
        };
        const itemText = li.innerText || '';
        const pm = itemText.match(/(\d{1,3})\s*%/);
        const progress = pm ? Number(pm[1]) : null;
        // 空心圆 + 百分数 = 未完成；100% / 实心对勾 = 已完成
        const finished = progress != null ? progress >= 99 : visible(check);
        return {
          i, num, title, time, chapter,
          progress,
          finished,
          partial: visible(half) || (progress != null && progress < 99),
          checkVisible: visible(check),
          current: li.classList.contains('current_play')
        };
      });
    });
    const previous = Array.isArray(this.state.videoCatalog) ? this.state.videoCatalog : [];
    const prevByKey = new Map(previous.map((v) => [v.key, v]));
    const oldDone = new Set(this.state.completed || []);
    for (const v of data) {
      v.key = ((v.num ? v.num + '|' : '') + v.title).trim() || ('index|' + v.i);
      v.platformFinished = v.finished;
      const prev = prevByKey.get(v.key);
      if (oldDone.has(v.key) || (prev && prev.finished) || oldDone.has('v' + v.i)) v.finished = true;
    }
    // 迁移旧的 v0/v1 索引记录到稳定 key
    const migrated = new Set();
    for (const c of oldDone) {
      if (/^v\d+$/.test(c)) { const idx = Number(c.slice(1)); if (data[idx]) migrated.add(data[idx].key); }
      else migrated.add(c);
    }
    for (const v of data) if (v.finished) migrated.add(v.key);
    const forced = new Set(this.state.forcePending || []);
    for (const v of data) {
      if (forced.has(v.key)) { v.finished = false; migrated.delete(v.key); }
    }
    this.videos = data;
    this.state.completed = [...migrated];
    this.state.videoCatalog = data.map((v) => ({ key: v.key, num: v.num, title: v.title, time: v.time, chapter: v.chapter, finished: v.finished, progress: v.progress, partial: v.partial }));
    this.state.videos = this.state.videoCatalog;
    this.total = data.length;
    this.done = data.filter((v) => v.finished).length;
    try { fs.writeFileSync(this.catalogPath, JSON.stringify(this.state.videoCatalog, null, 2)); } catch {}
    this.saveState();
    this.log('scan_videos', { total: this.total, finished: this.done, current: data.find((v) => v.current)?.num, catalogSaved: true });
    return data;
  }

  async refreshProgress() {
    await this.ensurePage();
    if (!this.loggedIn) await this.detectLogin();
    if (!this.isStudyUrl(this.page.url())) await this.gotoStudy();
    await sleep(1500);
    await this.closeMasks();
    await this.scanVideos();
    const finished = this.videos.filter((v) => v.finished).length;
    this.done = finished;
    this.saveState();
    return { done: this.done, total: this.total };
  }

  async humanClick(locator) {
    if (!(await locator.isVisible().catch(() => false))) throw new Error('目标元素不可见');
    const box = await locator.boundingBox();
    if (!box) throw new Error('找不到可点击位置');
    const x = box.x + box.width * (0.35 + Math.random() * 0.3);
    const y = box.y + box.height * (0.35 + Math.random() * 0.3);
    await this.page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 6) });
    await sleep(180 + Math.floor(Math.random() * 320));
    await this.page.mouse.down();
    await sleep(60 + Math.floor(Math.random() * 90));
    await this.page.mouse.up();
    await sleep(200 + Math.floor(Math.random() * 300));
  }

  async humanClickAt(locator, xRatio = 0.5, yRatio = 0.5) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('找不到可点击位置');
    const x = box.x + box.width * xRatio;
    const y = box.y + box.height * yRatio;
    await this.page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 6) });
    await sleep(180 + Math.floor(Math.random() * 320));
    await this.page.mouse.down();
    await sleep(60 + Math.floor(Math.random() * 90));
    await this.page.mouse.up();
    await sleep(300);
  }

  async isVideoMarked(index) {
    return await this.page.evaluate((i) => {
      const li = document.querySelectorAll('li.video')[i];
      if (!li) return false;
      const text = li.innerText || '';
      const pm = text.match(/(\d{1,3})\s*%/);
      if (pm) return Number(pm[1]) >= 99;
      const el = li.querySelector('.time_icofinish');
      if (!el) return false;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01 && r.width > 0 && r.height > 0;
    }, index).catch(() => false);
  }

  async waitForCheckmark(index, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const done = await this.page.evaluate((i) => {
        const li = document.querySelectorAll('li.video')[i];
        if (!li) return false;
        const text = li.innerText || '';
        const pm = text.match(/(\d{1,3})\s*%/);
        if (pm) return Number(pm[1]) >= 99;
        const el = li.querySelector('.time_icofinish');
        if (!el) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01 && r.width > 0 && r.height > 0;
      }, index).catch(() => false);
      if (done) return true;
      await sleep(1000);
    }
    return false;
  }

  async alignNextVideo(currentIndex) {
    const list = this.videos.map((v, i) => ({ index: i, key: v.key, num: v.num, title: v.title, progress: v.progress, finished: i === currentIndex ? true : v.finished }));
    const nextFallback = list.find((v) => !v.finished && v.index !== currentIndex)?.index ?? -1;
    if (!this.config.apiKey) return nextFallback;
    try {
      const data = await chat(this.config, [
        { role: 'system', content: '你是课程进度对齐助手。根据视频列表和完成状态，选择下一个应该观看的视频。只返回 JSON：{"nextIndex": 数字, "reason": "简短理由"}。如果全部完成，nextIndex 为 -1。' },
        { role: 'user', content: JSON.stringify({ currentIndex, videos: list }, null, 2) }
      ], null, 30000);
      const text = data.choices?.[0]?.message?.content || '';
      const m = text.match(/"nextIndex"\s*:\s*(-?\d+)/);
      let next = m ? Number(m[1]) : nextFallback;
      if (!Number.isInteger(next) || next < 0 || next >= this.videos.length || next === currentIndex || this.videos[next]?.finished) next = nextFallback;
      this.log('ai_align_next', { currentIndex, nextIndex: next, reason: text.slice(0, 300) });
      this.lastModel = { at: new Date().toISOString(), kind: 'align', question: 'next video after ' + currentIndex, reason: text.slice(0, 300), picked: [next] };
      return next;
    } catch (e) {
      this.log('ai_align_error', { msg: e.message, fallback: nextFallback });
      return nextFallback;
    }
  }

  async openChapterFor(index) {
    const num = this.videos[index]?.num || '';
    const no = num.split('.')[0];
    if (!no) return false;
    const cn = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十' };
    const labels = ['第' + (cn[no] || no) + '章', '第' + no + '章'];
    let ch = null;
    let label = labels[0];
    for (const l of labels) {
      const c = this.page.locator('.chapter').filter({ hasText: l }).first();
      if (await c.count().catch(() => 0)) { ch = c; label = l; break; }
    }
    if (!ch) return false;
    const head = ch.locator('.chapter-em, .chapter-title, .catalogue_title').first();
    try {
      if (await head.count().catch(() => 0)) await this.humanClick(head);
      else await this.humanClick(ch);
      this.log('chapter_opened', { index, label });
      await sleep(1500);
      return true;
    } catch (e) {
      this.log('chapter_open_failed', { index, label, msg: e.message });
      return false;
    }
  }

  async clickVideo(index) {
    await this.ensureStudyPage();
    await this.closeMasks();
    await this.dismissMessageBox();
    // 上一条视频的弹题可能还挂在 DOM 上，会拦截点击
    if (await this.isQuizPopup()) {
      this.log('stale_quiz_before_click', { index });
      await this.solveQuizPopup();
      await sleep(900);
    }
    this.log('click_video_start', { index });
    const expected = this.videos[index]?.title || '';
    const num = this.videos[index]?.num || '';
    let target = this.page.locator('li.video').filter({ hasText: expected }).first();
    if (expected && !(await target.count().catch(() => 0)) && num) target = this.page.locator('li.video').filter({ hasText: num }).first();
    if (expected && !(await target.count().catch(() => 0))) {
      await this.openChapterFor(index);
      target = this.page.locator('li.video').filter({ hasText: expected }).first();
      if (!(await target.count().catch(() => 0)) && num) target = this.page.locator('li.video').filter({ hasText: num }).first();
    }
    if (expected && !(await target.count().catch(() => 0))) throw new Error('目录里找不到目标视频：' + expected + '，拒绝按索引硬点');
    if (expected && !(await target.isVisible().catch(() => false))) {
      await this.openChapterFor(index);
      target = this.page.locator('li.video').filter({ hasText: expected }).first();
      if (!(await target.isVisible().catch(() => false)) && num) target = this.page.locator('li.video').filter({ hasText: num }).first();
      if (!(await target.isVisible().catch(() => false))) throw new Error('目标视频不在可见目录里：' + expected);
    }
    if (!expected) target = this.page.locator('li.video').nth(index);
    await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' })).catch(() => {});
    await sleep(700 + Math.floor(Math.random() * 500));
    const targetTitle = await target.locator('.catalogue_title').first().innerText().catch(() => '');
    const targetBox = await target.locator('.catalogue_title').first().boundingBox().catch(() => null);
    this.log('click_video_target', { index, expected, targetTitle, targetBox });
    if (targetBox) {
      const hit = await this.page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el ? { tag: el.tagName, cls: el.className, text: (el.innerText || '').slice(0, 80) } : null;
      }, { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 }).catch(() => null);
      this.log('click_video_hit', hit);
      if (hit && /el-dialog/.test(String(hit.cls || ''))) {
        this.log('click_blocked_by_dialog', { index, hit });
        if (await this.isQuizPopup()) await this.solveQuizPopup();
        else {
          const close = this.page.locator('.el-dialog__wrapper .el-dialog__headerbtn, .el-dialog__wrapper .el-dialog__close').first();
          if (await close.count().catch(() => 0)) await this.humanClick(close).catch(() => {});
        }
        await sleep(1200);
        const still = await this.page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          return el ? { tag: el.tagName, cls: el.className } : null;
        }, { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 }).catch(() => null);
        if (still && /el-dialog/.test(String(still.cls || ''))) {
          await this.page.evaluate(() => document.querySelectorAll('.el-dialog__wrapper.dialog-test').forEach((e) => e.remove())).catch(() => {});
          this.log('stale_dialog_removed');
          await sleep(600);
        }
      }
    }
    try {
      await this.humanClick(target.locator('.catalogue_title').first());
    } catch (e) {
      // 折叠章节里的元素没有可点击坐标，先展开章节再点
      await this.openChapterFor(index);
      target = this.page.locator('li.video').filter({ hasText: expected || num }).first();
      if (!(await target.count().catch(() => 0))) throw new Error('展开章节后仍找不到目标视频：' + expected);
      await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' })).catch(() => {});
      await this.humanClick(target.locator('.catalogue_title').first());
    }
    await sleep(1800 + Math.floor(Math.random() * 700));
    await this.closeMasks();
    let title = await this.page.locator('.videotop_lesson_tit').innerText().catch(() => '');
    if (expected && !title.includes(expected)) {
      this.log('click_video_retry', { index, expected, title });
      await sleep(800);
      // 按标题重新定位，绝不按旧 index 硬点
      target = this.page.locator('li.video').filter({ hasText: expected }).first();
      if (!(await target.count().catch(() => 0))) {
        await this.openChapterFor(index);
        target = this.page.locator('li.video').filter({ hasText: expected }).first();
      }
      if (await target.count().catch(() => 0)) {
        await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' })).catch(() => {});
        await sleep(500);
        await this.humanClick(target.locator('.catalogue_title').first()).catch(() => {});
      }
      await sleep(2200);
      await this.closeMasks();
      title = await this.page.locator('.videotop_lesson_tit').innerText().catch(() => '');
    }
    this.log('click_video', { index, expected, title });
    if (expected && !title.includes(expected)) throw new Error('视频没有切换成功：' + expected + ' / ' + title);
    return true;
  }

  async playCurrent(index) {
    await this.ensureStudyPage();
    if (!(await this.page.locator('video').count().catch(() => 0))) {
      const ok = await this.recoverToStudy('no_video');
      if (!ok) throw new Error('课程页面丢失');
    }
    const v = this.page.locator('video').first();
    await v.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    let info = await v.evaluate((v) => ({ t: v.currentTime, d: v.duration, paused: v.paused, ended: v.ended, src: v.currentSrc || v.src })).catch(() => null);
    if (!info) throw new Error('视频没有加载出来');
    // 切视频后如果视频元素还停在上一条的结尾，不能当成“新视频已完成”
    if (await this.isVideoMarked(index)) {
      this.log('video_already_marked', { index, t: info.t, d: info.d });
      return true;
    }
    if (info.d > 0 && info.t >= info.d - 1) {
      this.log('video_stale_end', { index, t: info.t, d: info.d, src: String(info.src).slice(0, 80) });
      // 新视频继承了上一条的结尾位置，模拟点击进度条最左侧回到开头
      const bar = this.page.locator('.vjs-progress-holder').first();
      if (await bar.isVisible().catch(() => false)) {
        await this.humanClickAt(bar, 0.02, 0.5).catch(() => {});
        await sleep(1200);
      }
      info = await v.evaluate((v) => ({ t: v.currentTime, d: v.duration, paused: v.paused, ended: v.ended, src: v.currentSrc || v.src })).catch(() => null);
      if (info && info.d > 0 && info.t >= info.d - 1) {
        // 兜底：只 seek 到 0，不做加速
        await v.evaluate((v) => { try { v.currentTime = 0; } catch {} }).catch(() => {});
        await sleep(1200);
        info = await v.evaluate((v) => ({ t: v.currentTime, d: v.duration, paused: v.paused, ended: v.ended, src: v.currentSrc || v.src })).catch(() => null);
      }
      if (info && info.d > 0 && info.t >= info.d - 1) throw new Error('切换后视频仍停在上一条结尾，拒绝标记完成');
    }
    const big = this.page.locator('.vjs-big-play-button').first();
    if (await big.isVisible().catch(() => false)) await this.humanClick(big).catch(() => {});
    await v.evaluate((v, rate) => { v.playbackRate = rate; return v.play().catch(() => {}); }, Number(this.config.speed) || 1).catch(() => {});
    let lastLog = -1;
    let lastT = 0;
    const expectedTitle = this.videos[index]?.title || '';
    for (let t = 0; t < 7200; t++) {
      await this.checkpoint();
      await sleep(1000);
      if (await this.hasBlockingOverlay()) await this.handleOverlay();
      const nowTitle = await this.page.locator('.videotop_lesson_tit').innerText().catch(() => '');
      if (expectedTitle && nowTitle && !nowTitle.includes(expectedTitle)) {
        this.log('video_changed_during_play', { index, expected: expectedTitle, now: nowTitle });
        throw new Error('播放中视频被刷新/切换：' + expectedTitle + ' / ' + nowTitle);
      }
      info = await v.evaluate((v) => ({ t: v.currentTime, d: v.duration, paused: v.paused, ended: v.ended, ready: v.readyState, rate: v.playbackRate })).catch(() => null);
      if (!info) break;
      if (!info.paused) this.addWatchTime(1);
      if (await this.isVideoMarked(index)) {
        this.log('video_marked_early', { index, t: Math.round(info.t), d: Math.round(info.d || 0) });
        return true;
      }
      const targetRate = Number(this.config.speed) || 1;
      if (info.rate && Math.abs(info.rate - targetRate) > 0.01) {
        await v.evaluate((v, r) => { try { v.playbackRate = r; } catch {} }, targetRate).catch(() => {});
        this.log('speed_enforced', { want: targetRate, got: info.rate });
      }
      if (lastT > 10 && info.t < lastT - 10) {
        this.log('video_rewound', { index, lastT: Math.round(lastT), now: Math.round(info.t) });
        throw new Error('播放进度被重置/页面被刷新');
      }
      lastT = Math.max(lastT, info.t || 0);
      if (info.ended || (info.d > 0 && info.t >= info.d - 0.8)) {
        if (info.t < 2) throw new Error('视频刚开始就结束，疑似旧状态，拒绝标记完成');
        this.log('video_end', { index, t: Math.round(info.t), d: Math.round(info.d) });
        return true;
      }
      if (info.paused && info.ready >= 2) {
        await this.humanClick(this.page.locator('.vjs-play-control').first()).catch(() => {});
        await v.evaluate((v) => v.play().catch(() => {})).catch(() => {});
      }
      const sec = Math.floor(info.t || 0);
      if (sec !== lastLog && sec % 30 === 0) {
        lastLog = sec;
        this.log('video_wait', { index, t: Math.round(info.t), d: Math.round(info.d || 0), paused: info.paused, rate: info.rate });
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
    const dom = await this.page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.1 && r.width > 50 && r.height > 50 && r.top >= 0;
      };
      const wrap = document.querySelector('#tcaptcha_transform_dy, .tcaptcha-transform, .tcaptcha, [class*="tcaptcha"]');
      if (visible(wrap)) return true;
      const frames = [...document.querySelectorAll('iframe')];
      if (frames.some((f) => /turing\.captcha|tcaptcha/.test(f.src || '') && visible(f))) return true;
      const text = document.body.innerText || '';
      return /拖动滑块|拖动下方滑块|完成验证|请完成.*验证|安全验证/.test(text) && frames.length > 0;
    }).catch(() => false);
    return Boolean(dom);
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
    if (this.captchaSolving) return true;
    this.captchaSolving = true;
    try {
    this.log('human_verification_detected');
    const vp = this.page.viewportSize() || { width: 1440, height: 1000 };
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (!(await this.isHumanVerification())) { this.log('captcha_solved'); return true; }
      await this.capture().catch(() => {});
      const shot = await this.page.screenshot({ type: 'png' }).catch(() => null);
      const d = shot ? await decideCaptchaVision({ config: this.config, screenshotBase64: shot.toString('base64'), log: (e, x) => this.log(e, x) }) : null;
      this.log('captcha_attempt', { attempt, decision: d });
      if (d?.action === 'drag' && [d.from_x, d.from_y, d.to_x, d.to_y].every((n) => Number.isFinite(n))) {
        await this.page.mouse.move(Number(d.from_x) * vp.width, Number(d.from_y) * vp.height);
        await this.page.mouse.down();
        await sleep(300);
        await this.page.mouse.move(Number(d.to_x) * vp.width, Number(d.to_y) * vp.height, { steps: 25 });
        await sleep(200);
        await this.page.mouse.up();
        await sleep(2500);
      } else if (d?.action === 'click_at' && Number.isFinite(d.x) && Number.isFinite(d.y)) {
        await this.page.mouse.click(Number(d.x) * vp.width, Number(d.y) * vp.height);
        await sleep(1500);
      } else {
        await sleep(1200);
      }
      if (!(await this.isHumanVerification())) { this.log('captcha_solved', { attempt }); return true; }
      // 失败后刷新验证码再试
      const refresh = this.page.locator('.tcaptcha-refresh, .tcaptcha-transform .refresh, [class*="refresh"]').first();
      if (await refresh.count().catch(() => 0) && await refresh.isVisible().catch(() => false)) await this.humanClick(refresh).catch(() => {});
      await sleep(1000);
    }
    this.attention = { title: '人机验证未通过', message: '自动拖动 6 次仍未通过。请在浏览器里手动完成滑块/拼图，然后点“我已处理，继续”。', image: '/api/screenshot?v=' + this.screenshotVersion };
    this.log('captcha_human_required');
    this.status = 'waiting_human';
    await this.waitHuman();
    return true;
    } finally {
      this.captchaSolving = false;
    }
  }

  async dismissMessageBox() {
    const boxes = this.page.locator('.el-message-box__wrapper');
    const n = await boxes.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = boxes.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      const text = await b.innerText().catch(() => '');
      if (!/提示|未做答|不能关闭/.test(text)) continue;
      const btn = b.locator('button').filter({ hasText: /确定|知道了|关闭/ }).first();
      let closed = false;
      if (await btn.count().catch(() => 0)) {
        try { await this.humanClick(btn); closed = true; } catch (e) { this.log('message_box_btn_not_clickable', { msg: e.message }); }
      }
      if (!closed) {
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.keyboard.press('Enter').catch(() => {});
        await sleep(500);
      }
      // 有些提示框按钮被 CSS 隐藏，但仍然拦截点击；清掉提示层
      const still = await this.page.locator('.el-message-box__wrapper').count().catch(() => 0);
      if (still) {
        await this.page.evaluate(() => document.querySelectorAll('.el-message-box__wrapper').forEach((e) => e.remove())).catch(() => {});
        this.log('message_box_removed');
      }
      this.log('message_box_dismissed', { text: text.replace(/\s+/g, ' ').slice(0, 120) });
      await sleep(600);
      return true;
    }
    return false;
  }

  async quizDialog() {
    const all = this.page.locator('.el-dialog__wrapper');
    const n = await all.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const d = all.nth(i);
      const text = await d.innerText().catch(() => '');
      if (/【(判断题|单选题|多选题)】|弹题|请选择|正确答案/.test(text)) return d;
    }
    return null;
  }

  async isQuizPopup() {
    return Boolean(await this.quizDialog());
  }

  async solveQuizPopup() {
    await this.dismissMessageBox();
    const dlg = await this.quizDialog();
    const root = dlg || this.page;
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
    await this.recordPopup(text, finalOptions, type);
    let answered = false;
    if (finalOptions.length >= 2) {
      let decision = this.lookupQuiz('popup', question, finalOptions, type);
      if (decision) {
        this.log('quiz_bank_hit', { category: 'popup', picked: decision.indexes, question: question.slice(0, 180) });
      } else {
        const textDecision = await decideQuiz({ config: this.config, question, options: finalOptions, type, log: (e, d) => this.log(e, d) });
        decision = textDecision;
        try {
          const shot = await this.page.screenshot({ type: 'png' });
          const visionDecision = await decideQuizVision({ config: this.config, screenshotBase64: shot.toString('base64'), question, options: finalOptions, type, log: (e, d) => this.log(e, d) });
          if (visionDecision && visionDecision.indexes?.length) {
            this.log('popup_quiz_vision_check', { text: textDecision.indexes, vision: visionDecision.indexes, reason: visionDecision.reason });
            decision = visionDecision;
          }
        } catch (e) {
          this.log('popup_quiz_vision_check_error', { msg: e.message });
        }
      }
      this.lastModel = { at: new Date().toISOString(), kind: 'quiz', question: question.slice(0, 180), options: finalOptions, picked: decision.indexes, reason: decision.reason, source: decision.source };
      this.log('popup_quiz_model', { picked: decision.indexes, source: decision.source, reason: decision.reason });
      let clicked = 0;
      const chosen = decision.indexes || [];
      for (const i of chosen) {
        const val = finalOptions[i];
        if (!val) continue;
        const byNode = root.locator('.topic-item, .node_detail, .option, .answer-item, .nodeLab, label').filter({ hasText: val }).first();
        if (await byNode.count().catch(() => 0)) {
          const already = await byNode.evaluate((li) => /zhong/.test(li.querySelector('use')?.getAttribute('xlink:href') || '') || Boolean(li.querySelector('input:checked'))).catch(() => false);
          if (already) { clicked++; }
          else {
            try { await this.humanClick(byNode); clicked++; }
            catch (e) { this.log('popup_option_click_error', { val, msg: e.message }); }
          }
        } else {
          const byText = root.getByText(val, { exact: true }).first();
          if (await byText.count().catch(() => 0)) {
            try { await this.humanClick(byText); clicked++; }
            catch (e) { this.log('popup_option_click_error', { val, msg: e.message }); }
          }
        }
        await sleep(350);
      }
      const readSelected = async () => root.locator('.topic-item').evaluateAll((els) => els.map((li) => {
        const icon = li.querySelector('use')?.getAttribute('xlink:href') || '';
        return /zhong/.test(icon) || /active|selected|checked/i.test(li.className) || Boolean(li.querySelector('input:checked'));
      })).catch(() => []);
      let selected = await readSelected();
      let allSelected = chosen.length > 0 && chosen.every((i) => selected[i]);
      if (!allSelected) {
        this.log('quiz_selection_mismatch', { chosen, selected });
        await this.dismissMessageBox();
        for (const i of chosen) {
          if (selected[i]) continue;
          const val = finalOptions[i];
          const row = root.locator('.topic-item').filter({ hasText: val }).first();
          if (await row.count().catch(() => 0)) await this.humanClick(row).catch(() => {});
          await sleep(250);
        }
        selected = await readSelected();
        allSelected = chosen.length > 0 && chosen.every((i) => selected[i]);
      }
      this.log('popup_options_clicked', { picked: chosen, clicked, selected, allSelected, total: finalOptions.length });
      if (!allSelected) this.log('popup_options_click_failed');
      answered = allSelected;
      if (answered) this.saveQuizAnswer('popup', question, finalOptions, type, chosen);
    } else {
      // 选项是图片/无法从文本提取，交给视觉模型直接点
      const state = await this.pageState();
      state.bodyText = (state.bodyText || '') + '\n这是视频弹题，请选择正确答案并提交。';
      const d = await this.decidePage(state);
      this.lastModel = { at: new Date().toISOString(), kind: 'quiz', question: question.slice(0, 180), options: [], picked: [], reason: d.reason, source: 'vision' };
      this.log('popup_quiz_vision', d);
      await this.executeDecision(d);
      answered = true;
    }
    await sleep(700);
    for (const t of ['提交', '确定', '保存', '下一题']) {
      const b = root.getByText(t, { exact: true }).first();
      if (await b.count().catch(() => 0) && await b.isVisible().catch(() => false)) { await this.humanClick(b).catch(() => {}); break; }
    }
    // 视频弹题通常选完后才允许关闭
    await sleep(900);
    const closeBtn = root.getByText('关闭', { exact: true }).first();
    if (answered && await closeBtn.count().catch(() => 0) && await closeBtn.isVisible().catch(() => false)) {
      await this.humanClick(closeBtn).catch(() => {});
    } else if (!answered) {
      this.log('popup_not_answered_no_close');
    }
    await sleep(1200);
    const still = await this.quizDialog();
    this.log('quiz_popup_check', { answered, stillOpen: Boolean(still) });
    if (still) await this.dismissMessageBox();
    return answered && !still;
  }

  async recordPopup(text, options, type) {
    try {
      const dir = path.join(this.rootDir, 'data', 'popups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.join(dir, 'popup-' + stamp);
      await this.page.screenshot({ path: base + '.png', fullPage: false }).catch(() => {});
      const html = await this.page.locator('.el-dialog__wrapper:visible, .dialog-warn:visible, .dialog-quit:visible').first().innerHTML().catch(() => '');
      fs.writeFileSync(base + '.json', JSON.stringify({ at: new Date().toISOString(), text, options, type, html }, null, 2));
      this.log('popup_recorded', { file: path.basename(base) + '.json' });
    } catch (e) {
      this.log('popup_record_failed', { msg: e.message });
    }
  }

  async handleOverlay() {
    // 弹题必须先答题，不能先点“关闭”
    if (await this.isHumanVerification()) { await this.handleHumanVerification(); return; }
    if (await this.isQuizPopup()) { await this.solveQuizPopup(); return; }
    await this.closeMasks();
    if (await this.hasBlockingOverlay()) {
      const state = await this.pageState();
      const d = await this.decidePage(state);
      this.lastModel = { at: new Date().toISOString(), kind: 'action', decision: d, reason: d.reason };
      this.log('overlay_decision', d);
      await this.executeDecision(d);
      await sleep(1200);
    }
  }

  debugTools() {
    const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
    return [
      fn('get_page_state', '读取当前页面 URL、正文和可点击元素，用于诊断。', {}, []),
      fn('dump_videos', '导出当前 DOM 中所有 li.video 的标题、编号、坐标和可见性。', {}, []),
      fn('dump_tests', '导出当前目录里的平时测试/章节测试条目。', {}, []),
      fn('open_test', '打开第 index 个平时测试，切到考试标签页并返回页面状态。', { index: { type: 'integer' } }, ['index']),
      fn('solve_exam', '对当前考试页逐题作答并提交。', {}, []),
      fn('dump_exam', '导出考试页的 iframe、题目 DOM 和正文，用于适配题库。', {}, []),
      fn('capture_page', '截取当前 this.page 的实时截图并保存到 shots/agent-capture.png。', {}, []),
      fn('switch_exam', '切换到已打开的考试标签页并截图。', {}, []),
      fn('dump_review', '导出已交作业的题目、选项 class、AI 解析文本。', {}, []),
      fn('review_answers', '从已交作业解析页提取每题选项的正确/选中图标。', {}, []),
      fn('exam_analysis', '打开第 index 题的 AI解析并返回解析文本。', { index: { type: 'integer' } }, ['index']),
      fn('click_text', '按可见文本点击（人类式点击）。', { text: { type: 'string' } }, ['text']),
      fn('click_nth', '点击 CSS 选择器的第 n 个（人类式点击）。', { selector: { type: 'string' }, index: { type: 'integer' } }, ['selector', 'index']),
      fn('goto_url', '打开指定 URL 并等待。裸 #/webExamList 会被拒绝。', { url: { type: 'string' } }, ['url']),
      fn('pages_tree', '列出当前浏览器所有标签页（id/kind/url/是否当前），用于回溯与切换。', {}, []),
      fn('pages_dedupe', '关闭同一 URL 的重复标签页，只保留一个，不动浏览器进程。', {}, []),
      fn('page_reload', '重新加载当前标签页（不重启浏览器）。', {}, []),
      fn('bank_upsert', '写入题库：需 index、question、options、answers、type；examId 自动取当前考试页。', {
        index: { type: 'integer' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
        answers: { type: 'array', items: { type: 'string' } }, type: { type: 'string' }, examId: { type: 'string' }, examTitle: { type: 'string' }
      }, ['index', 'options', 'answers']),
      fn('bank_show', '按 examId 或当前页展示题库条目（题号/答案/选项数）。', { examId: { type: 'string' } }, []),
      fn('exam_dump_all', '只翻页读取全部题干和选项，不做任何选择、不提交。', {}, []),
      fn('exam_dry_run', '纯题库试跑：只用题库答题，不调模型、不点选项、不提交，只回车库命中与缺题。', {}, []),
      fn('dom_probe', '读取指定选择器的 DOM 结构（tag/class/text），用于适配答题卡与题目容器。', { selector: { type: 'string' } }, ['selector']),
      fn('goto_question', '按答题卡切到第 n 题（1 基）并回读当前可见题目内容。', { n: { type: 'integer' } }, ['n']),
      fn('click_xy', '在页面坐标 (x,y) 做一次真实鼠标点击，用于点选验证码字符。', { x: { type: 'integer' }, y: { type: 'integer' } }, ['x', 'y']),
      fn('review_checked', '读取当前解析页每题：题干、选项、实际勾选项、对错。只在解析页用。', {}, []),
      fn('bank_verify', '校验题库与题库映射：选项乱序后仍能命中正确内容。', { examId: { type: 'string' } }, []),
      fn('page_focus', '按 id 切到某个已存在标签页，不重开浏览器。', { id: { type: 'string' } }, ['id']),
      fn('page_close', '按 id 关闭某个非当前标签页。', { id: { type: 'string' } }, ['id']),
      fn('open_exam_list', '从课程学习页点击“作业考试”打开考试列表（正确入口，带上下文）。', {}, []),
      fn('open_chapter', '打开指定章节测试：传 chapter 如“第二章单元测试”，可选 mode=start|review。', { chapter: { type: 'string' }, mode: { type: 'string' } }, ['chapter']),
      fn('start_exam_title', '按章节标题点击该行“开始答题”。', { title: { type: 'string' } }, ['title']),
      fn('click_selector', '点击 CSS 选择器。只用于明确的页面控件。', { selector: { type: 'string' }, reason: { type: 'string' } }, ['selector', 'reason']),
      fn('click_at', '按 0-1 坐标点击页面。', { x: { type: 'number' }, y: { type: 'number' }, reason: { type: 'string' } }, ['x', 'y', 'reason']),
      fn('drag', '从起点拖到终点，坐标 0-1。', { from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' }, reason: { type: 'string' } }, ['from_x', 'from_y', 'to_x', 'to_y', 'reason']),
      fn('press_key', '按键盘按键。', { key: { type: 'string' }, reason: { type: 'string' } }, ['key', 'reason']),
      fn('wait', '等待毫秒。', { ms: { type: 'integer' }, reason: { type: 'string' } }, ['ms', 'reason']),
      fn('open_study_page', '重新打开配置里的课程学习页并扫描。', { reason: { type: 'string' } }, ['reason']),
      fn('scan_videos', '重新扫描视频列表和完成标记。', { reason: { type: 'string' } }, ['reason']),
      fn('get_speed', '读取当前视频元素的实际播放速度。', {}, []),
      fn('dump_quiz', '导出当前弹题的选项样式、SVG、提示框和可见性。', {}, []),
      fn('dismiss_boxes', '关闭挡住弹题的提示框/消息框。', {}, []),
      fn('solve_quiz', '读取并处理当前弹题，返回是否成功关闭。', {}, []),
      fn('write_plugin', '写一个新的浏览器操作脚本到 data/plugins。代码格式：module.exports = async ({page,bot,sleep,log,args}) => { ... }', { name: { type: 'string' }, code: { type: 'string' } }, ['name', 'code']),
      fn('run_plugin', '运行 data/plugins 里的脚本。', { name: { type: 'string' }, args: { type: 'object' } }, ['name']),
      fn('list_plugins', '列出已有插件。', {}, []),
      fn('patch_method', '永久覆盖 bot 的一个方法，用于调整内部逻辑。code 是函数体，内部可用 this。', { method: { type: 'string' }, code: { type: 'string' } }, ['method', 'code']),
      fn('set_speed', '设置当前视频元素播放速度，只允许 1.0 或 1.5。', { rate: { type: 'number' } }, ['rate']),
      fn('start_script', '启动正常刷课流程。', { reason: { type: 'string' } }, ['reason']),
      fn('pause_script', '暂停刷课流程。', { reason: { type: 'string' } }, ['reason']),
      fn('resume_script', '继续刷课流程。', { reason: { type: 'string' } }, ['reason']),
      fn('stop_script', '停止刷课流程。', { reason: { type: 'string' } }, ['reason']),
      fn('request_human', '请求人工处理当前页面。', { reason: { type: 'string' } }, ['reason'])
    ];
  }

  async runAgentTool(name, args) {
    const vp = this.page.viewportSize() || { width: 1440, height: 1000 };
    if (['click_selector', 'click_at', 'drag', 'press_key'].includes(name) && this.running) {
      await this.pause();
      await sleep(700);
    }
    if (name === 'get_page_state') return await this.pageState();
    if (name === 'exam_analysis') {
      const idx = Number(args.index) || 0;
      const q = this.page.locator('.examPaper_subject').nth(idx);
      await q.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(700 + Math.floor(Math.random() * 700));
      const a = q.locator('.ai_annex').first();
      if (await a.count().catch(() => 0)) await this.humanClick(a).catch(() => {});
      await sleep(2500 + Math.floor(Math.random() * 1200));
      return await this.page.evaluate(() => [...document.querySelectorAll('.ai-talk-box')].map((e) => (e.innerText || '').replace(/\s+/g, ' ').slice(0, 4000)));
    }
    if (name === 'review_answers') return await this.page.evaluate(() => [...document.querySelectorAll('.examPaper_subject')].map((q, i) => ({
      i,
      stem: (q.querySelector('.subject_describe')?.innerText || '').replace(/\s+/g, ' ').trim(),
      type: (q.querySelector('.subject_type')?.innerText || '').trim(),
      options: [...q.querySelectorAll('.nodeLab')].map((n) => {
        const img = n.querySelector('img.flagChecked');
        return { text: (n.innerText || '').replace(/^\s*[A-E][.、]\s*/, '').replace(/\s+/g, ' ').trim(), src: img?.src || '', cls: n.className, checked: Boolean(n.querySelector('input:checked')), detail: n.querySelector('.node_detail')?.className || '' };
      })
    })));
    if (name === 'dump_review') return await this.page.evaluate(() => ({
      url: location.href,
      body: (document.body.innerText || '').slice(0, 8000),
      analysis: [...document.querySelectorAll('[class*=ai-], [class*=analysis], [class*=explain], [class*=jiexi]')].map((e) => ({ cls: e.className, text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 1000) })).filter((x) => x.text),
      subjects: [...document.querySelectorAll('.examPaper_subject')].map((q, i) => ({
        i,
        text: (q.innerText || '').replace(/\s+/g, ' ').slice(0, 1000),
        options: [...q.querySelectorAll('.nodeLab')].map((n) => ({ text: (n.innerText || '').replace(/\s+/g, ' ').trim(), cls: n.className, detail: n.parentElement?.querySelector('.node_detail')?.className || '' })),
        html: q.innerHTML.slice(0, 6000)
      }))
    }));
    if (name === 'switch_exam') {
      const pages = (this.context?.pages() || []).filter((p) => !p.isClosed() && p.url().includes('onlineexamh5new.zhihuishu.com'));
      const exam = pages.filter((p) => p.url().includes('/dohomework/')).pop() || pages.pop();
      if (exam) { this.page = exam; await this.page.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(1500); }
      const out = path.join(this.shotsDir, 'agent-capture.png');
      await this.page.screenshot({ path: out, fullPage: false }).catch(() => {});
      return { path: out, url: this.page.url(), pages: (this.context?.pages() || []).map((p) => p.url()) };
    }
    if (name === 'capture_page') {
      const out = path.join(this.shotsDir, 'agent-capture.png');
      const cur = path.join(this.shotsDir, 'current.png');
      await this.page.bringToFront().catch(() => {});
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(1200);
      // 空白页检测：截图太小说明渲染未完成，重试一次
      let buf = await this.page.screenshot({ path: out, fullPage: false }).catch(() => null);
      if (buf && buf.length < 12000) {
        await this.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await sleep(2000);
        buf = await this.page.screenshot({ path: out, fullPage: false }).catch(() => null);
      }
      if (buf) fs.writeFileSync(cur, buf);
      this.screenshotVersion++;
      const textLen = await this.page.evaluate(() => (document.body.innerText || '').length).catch(() => 0);
      this.log('capture_page', { bytes: buf ? buf.length : 0, textLen });
      return { path: out, bytes: buf ? buf.length : 0, bodyTextLength: textLen, url: this.page.url() };
    }
    if (name === 'dump_exam') return await this.page.evaluate(() => ({
      url: location.href,
      text: (document.body.innerText || '').slice(0, 3000),
      iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height })),
      candidates: [...document.querySelectorAll('[class*=topic], [class*=subject], [class*=exam], [class*=question], .nodeLab, .node_detail')].slice(0, 40).map((e) => ({ tag: e.tagName, cls: e.className, text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 200) }))
    }));
    if (name === 'solve_exam') return await this.solveExam();
    if (name === 'open_test') {
      const idx = Number(args.index) || 0;
      const before = new Set(this.context.pages());
      const item = this.page.locator('li.chapter-test').nth(idx);
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(500);
      await this.humanClick(item).catch(async () => { await item.click({ force: true }).catch(() => {}); });
      await sleep(4000);
      const after = this.context.pages().filter((p) => !before.has(p));
      if (after.length) { this.page = after[after.length - 1]; await this.page.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(3000); }
      return await this.pageState();
    }
    if (name === 'dump_tests') return await this.page.evaluate(() => [...document.querySelectorAll('li.chapter-test, .chapter-test')].map((li, i) => {
      const r = li.getBoundingClientRect();
      return { i, text: (li.innerText || '').replace(/\s+/g, ' ').slice(0, 200), cls: li.className, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, visible: r.width > 0 && r.height > 0 };
    }));
    if (name === 'dump_videos') return await this.page.evaluate(() => [...document.querySelectorAll('li.video')].map((li, i) => {
      const r = li.getBoundingClientRect();
      const s = getComputedStyle(li);
      return {
        i,
        num: (li.querySelector('.catalogue_title4')?.innerText || '').replace(/\s+/g, ' ').trim(),
        title: (li.querySelector('.catalogue_title')?.innerText || '').replace(/\s+/g, ' ').trim(),
        text: (li.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        display: s.display,
        visibility: s.visibility,
        visible: s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
      };
    }));
    if (name === 'start_exam_title') {
      const title = String(args.title || '');
      const r = await this.page.evaluate((t) => {
        const a = [...document.querySelectorAll('a.course_ewname')].find((x) => (x.innerText || '').includes(t));
        if (!a) return { ok: false, reason: 'title not found' };
        const card = a.closest('.course') || a.closest('.courseList') || a.parentElement?.parentElement;
        const btn = card?.querySelector('a.jobExamComBtn') || [...document.querySelectorAll('.examItemWrap')].find((x) => (x.innerText || '').includes(t))?.querySelector('.examChartBox1');
        if (!btn) return { ok: false, reason: 'button not found' };
        btn.click();
        return { ok: true, title: btn.innerText };
      }, title).catch((e) => ({ ok: false, reason: e.message }));
      await sleep(3500);
      return { ...r, url: this.page.url(), pages: this.context.pages().map((p) => p.url()) };
    }
    if (name === 'bank_upsert') {
      const bank = this.ensureQuizBank();
      let examId = String(args.examId || '').trim() || this.currentExamId();
      examId = examId.replace(/\/0$/, '');
      const index = Number(args.index);
      if (!examId) return { ok: false, error: '当前不在考试页，且未提供 examId' };
      if (!Number.isInteger(index) || index < 0) return { ok: false, error: 'index 必须是非负整数' };
      const options = (args.options || []).map((x) => String(x).trim()).filter(Boolean);
      if (options.length < 2) return { ok: false, error: 'options 至少 2 项' };
      const answers = (args.answers || []).map((x) => String(x).trim()).filter(Boolean);
      if (!answers.length) return { ok: false, error: 'answers 不能为空' };
      const norm = (s) => this.normalizeQuizQuestion(s);
      const hit = answers.map((a) => options.findIndex((o) => norm(o) === norm(a) || norm(o).includes(norm(a)) || norm(a).includes(norm(o))));
      const miss = answers.filter((a, i) => hit[i] < 0);
      if (miss.length) return { ok: false, error: '答案不在选项里：' + miss.join(' / '), options, answers };
      const type = String(args.type || '').toLowerCase().includes('check') || answers.length > 1 ? 'checkbox' : 'radio';
      if (type === 'radio' && answers.length !== 1) return { ok: false, error: '单选题只能有 1 个答案', answers };
      // 同题号覆盖式写入（重做/修复场景），同时保留内容键，便于跨题型匹配
      const key = examId + '#' + index;
      const prev = bank.chapter[key];
      bank.chapter[key] = {
        examId, examIndex: index, type,
        examTitle: String(args.examTitle || prev?.examTitle || ''),
        question: String(args.question || prev?.question || '（题干为图片/动态文本，请根据截图和选项作答）'),
        options, answers,
        indexes: hit,
        updatedAt: new Date().toISOString(),
        source: 'manual'
      };
      fs.writeFileSync(this.quizBankPath, JSON.stringify(bank, null, 2));
      this.log('bank_upsert', { examId, index, type, answers });
      return { ok: true, key, type, answers, indexes: hit, optionsCount: options.length };
    }
    if (name === 'exam_dry_run') {
      // 优先当前页；当前页不是答题页时才在标签页里找
      if (!String(this.page?.url?.() || '').includes('/dohomework/')) {
        const pages = (this.context?.pages() || []).filter((p2) => !p2.isClosed());
        const answerPage = pages.filter((p2) => p2.url().includes('/dohomework/')).pop();
        if (answerPage) { this.page = answerPage; this.page.setDefaultTimeout(15000); await this.page.bringToFront().catch(() => {}); }
        else return { ok: false, error: '没有找到答题页（dohomework），请先 open_chapter 打开某个测试' };
      }
      return await this.solveExam({ dryRun: true, bankOnly: true });
    }
    if (name === 'review_checked') {
      return await this.page.evaluate(() => {
        return [...document.querySelectorAll('.examPaper_subject')].map((b, i) => {
          const stem = (b.querySelector('.subject_describe')?.innerText || '').replace(/\s+/g, ' ').trim();
          const type = (b.querySelector('.subject_type')?.innerText || '').trim();
          const opts = [...b.querySelectorAll('.nodeLab')].map((n) => {
            const img = n.querySelector('img.flagChecked, img');
            const src = img ? (img.getAttribute('src') || '') : '';
            const txt = (n.querySelector('.node_detail')?.innerText || n.innerText || '').replace(/^\s*[A-E][.、]\s*/, '').replace(/\s+/g, ' ').trim();
            return { txt, src: src.slice(-30), detailCls: (n.querySelector('.node_detail')?.className || '') };
          });
          const body = (b.innerText || '');
          const result = /错误/.test(body) ? 'wrong' : (/正确/.test(body) ? 'right' : '');
          const score = (body.match(/本题的得分\s*(\d+)\s*分/) || [])[1] || '';
          return { i, type: /多选/.test(type) ? 'checkbox' : 'radio', stem, result, score, opts };
        });
      }).catch((e) => ({ error: e.message }));
    }
    if (name === 'click_xy') {
      const x = Number(args.x), y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'x/y invalid' };
      await this.page.mouse.move(x - 40, y - 30, { steps: 4 }).catch(() => {});
      await sleep(160);
      await this.page.mouse.move(x, y, { steps: 6 }).catch(() => {});
      await sleep(120);
      await this.page.mouse.down().catch(() => {});
      await sleep(90);
      await this.page.mouse.up().catch(() => {});
      await sleep(700);
      return { ok: true, x, y };
    }
    if (name === 'goto_question') {
      const n = Number(args.n) || 1;
      const ok = await this.gotoQuestion(n - 1);
      const cur = await this.readCurrentSelection();
      const stem = await this.page.evaluate(() => {
        const blocks = [...document.querySelectorAll('.examPaper_subject')];
        const b = blocks.find((x) => x.offsetParent !== null);
        if (!b) return '';
        const d = b.querySelector('.subject_describe');
        return (d ? d.innerText : '').replace(/\s+/g, ' ').trim();
      }).catch(() => '');
      const idx = await this.page.evaluate(() => [...document.querySelectorAll('.examPaper_subject')].findIndex((x) => x.offsetParent !== null)).catch(() => -1);
      return { ok, n, visibleBlockIndex: idx, stem, texts: cur ? cur.texts : [], checked: cur ? cur.checked : [] };
    }
    if (name === 'dom_probe') {
      const sel = String(args.selector || '');
      return await this.page.evaluate((s) => {
        const nodes = [...document.querySelectorAll(s)];
        return nodes.slice(0, 30).map((n, i) => ({
          i, tag: n.tagName, cls: String(n.className || '').slice(0, 60),
          text: (n.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
          html: n.outerHTML.slice(0, 1200)
        }));
      }, sel);
    }
    if (name === 'exam_dump_all') {
      const total = await this.page.evaluate(() => Number((document.querySelector('.examPaper_partTit')?.innerText || '').match(/总题数[:：]\s*(\d+)/)?.[1] || 0)).catch(() => 0);
      const cards = await this.page.evaluate(() => document.querySelectorAll('.answerCard_list li').length).catch(() => 0);
      const n = total || cards || 1;
      const out = [];
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          const cardBtn = this.page.locator('.answerCard_list li').nth(i);
          if (await cardBtn.count().catch(() => 0)) {
            await cardBtn.scrollIntoViewIfNeeded().catch(() => {});
            await cardBtn.click({ force: true }).catch(() => {});
          }
          await sleep(900);
        }
        const q = await this.page.evaluate(() => {
          const blocks = [...document.querySelectorAll('.examPaper_subject')];
          const b = blocks.find((x) => x.offsetParent !== null) || blocks[0];
          if (!b) return null;
          const desc = b.querySelector('.subject_describe');
          const stem = (desc ? desc.innerText : '').replace(/\s+/g, ' ').trim();
          const type = (b.querySelector('.subject_type')?.innerText || '').trim();
          const opts = [...b.querySelectorAll('.nodeLab')].map((n2) => (n2.querySelector('.node_detail')?.innerText || n2.innerText || '').replace(/^\s*[A-E][.、]\s*/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
          const checked = [...b.querySelectorAll('.node_detail.onChecked')].map((n2) => (n2.innerText || '').trim());
          const imgs = [...b.querySelectorAll('.subject_describe img, .subject_stem img')].map((im) => im.src);
          return { stem, type: /多选/.test(type) ? 'checkbox' : 'radio', opts, checked, imgs };
        }).catch(() => null);
        out.push({ i, ...(q || {}) });
      }
      this.log('exam_dump_all', { count: out.length });
      return { ok: true, count: out.length, questions: out };
    }
    if (name === 'bank_show') {
      const bank = this.ensureQuizBank();
      let examId = String(args.examId || '').trim().replace(/\/0$/, '') || this.currentExamId();
      const rows = Object.entries(bank.chapter || {})
        .filter(([, v]) => !examId || String(v.examId || '').replace(/\/0$/, '') === examId)
        .map(([k, v]) => ({ key: k, index: v.examIndex, type: v.type, answers: (v.answers || []).slice(0, 1).join(' / ').slice(0, 60) }))
        .sort((a, b) => a.index - b.index);
      return { ok: true, examId, count: rows.length, rows };
    }
    if (name === 'bank_verify') {
      const bank = this.ensureQuizBank();
      const examId = String(args.examId || '').trim().replace(/\/0$/, '') || this.currentExamId();
      const rows = Object.values(bank.chapter || {}).filter((v) => !examId || String(v.examId || '').replace(/\/0$/, '') === examId);
      let okN = 0; const fails = [];
      for (const v of rows) {
        const shuffled = [...(v.options || [])].reverse();
        const r = this.lookupExamAnswer(examId, v.examIndex, shuffled, v.type);
        const got = (r ? r.indexes : []).map((i) => shuffled[i]).sort().join('|');
        const want = (v.answers || []).slice().sort().join('|');
        if (got === want) okN++; else fails.push({ index: v.examIndex, got, want });
      }
      return { ok: fails.length === 0, examId, checked: rows.length, pass: okN, fails };
    }
    if (name === 'pages_tree') return await this.pageTree();
    if (name === 'pages_dedupe') {
      const regs = this.pageRegistry().filter((x) => !x.page.isClosed());
      const groups = new Map();
      for (const rec of regs) {
        let u = '';
        try { u = rec.page.url(); } catch { continue; }
        if (!groups.has(u)) groups.set(u, []);
        groups.get(u).push(rec);
      }
      const closed = [];
      for (const [u, list] of groups) {
        if (list.length < 2) continue;
        // 每组保留：当前工作页优先，否则第一个
        const keep = list.find((x) => x.page === this.page) || list[0];
        for (const rec of list) {
          if (rec === keep) continue;
          const live = this.context.pages().filter((x) => !x.isClosed());
          if (live.length <= 1) break;
          await rec.page.close().catch(() => {});
          closed.push({ id: rec.id, url: u });
        }
      }
      // 保证 this.page 永远指向活的页面
      if (!this.page || this.page.isClosed()) {
        const liveReg = this.pageRegistry().filter((x) => !x.page.isClosed());
        if (liveReg.length) { this.page = liveReg[0].page; this.page.setDefaultTimeout(15000); }
      }
      this.log('pages_dedupe', { closed: closed.length });
      return { ok: true, closed, current: this.page && !this.page.isClosed() ? (this.page.url() || '') : null, tree: await this.pageTree() };
    }
    if (name === 'page_reload') {
      const before = this.page.url();
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(3000);
      this.log('page_reload', { before, after: this.page.url() });
      return { ok: true, before, after: this.page.url() };
    }
    if (name === 'page_focus') return await this.focusPageById(String(args.id || ''));
    if (name === 'page_close') return await this.closePageById(String(args.id || ''));
    if (name === 'open_exam_list') {
      await this.ensureStudyPage();
      const before = new Set(this.context.pages());
      const link = this.page.locator('a').filter({ hasText: /^作业考试$/ }).first();
      if (!(await link.count().catch(() => 0))) return { ok: false, error: '学习页没有找到“作业考试”入口', tree: await this.pageTree() };
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(400);
      await this.humanClick(link).catch(async () => { await link.click({ force: true }).catch(() => {}); });
      await sleep(4000);
      let opened = this.context.pages().filter((p2) => !before.has(p2) && !p2.isClosed());
      // 兜底：JS 直接派发 click（新标签被拦截时）
      if (!opened.length) {
        await link.evaluate((n) => n.click()).catch(() => {});
        await sleep(4500);
        opened = this.context.pages().filter((p2) => !before.has(p2) && !p2.isClosed());
      }
      // 再兜底：同页跳转
      if (!opened.length && this.page.url().includes('webExamList')) {
        opened = [this.page];
      }
      const target = opened.pop() || this.context.pages().find((p2) => p2.url().includes('webExamList'));
      if (!target) {
        const shot = await this.page.screenshot({ type: 'png' }).catch(() => null);
        this.log('open_exam_list_fail', { url: this.page.url(), shotBytes: shot ? shot.length : 0 });
        return { ok: false, error: '点击后没有出现考试标签页', url: this.page.url(), shotBytes: shot ? shot.length : 0, tree: await this.pageTree() };
      }
      await target.waitForLoadState('domcontentloaded').catch(() => {});
      await target.waitForSelector('.examItemWrap, .examBox, a.course_ewname', { timeout: 20000 }).catch(() => {});
      await sleep(1200);
      this.page = target;
      this.page.setDefaultTimeout(15000);
      this.registerPage(target, { label: 'exam-list' });
      this.log('open_exam_list', { url: target.url() });
      return { ok: true, url: target.url(), tree: await this.pageTree() };
    }
    if (name === 'open_chapter') {
      const chapter = String(args.chapter || '');
      const mode = String(args.mode || 'start');
      if (!chapter) return { ok: false, error: 'chapter required' };
      if (!String(this.page?.url?.() || '').includes('webExamList')) {
        const r = await this.runAgentTool('open_exam_list', {}).catch(() => null);
        if (!r || !r.ok) return { ok: false, error: '需要先打开考试列表', detail: r };
      }
      const before = new Set(this.context.pages());
      const clicked = await this.page.evaluate(({ t, m }) => {
        const wraps = [...document.querySelectorAll('.examItemWrap, .course, li')];
        const card = wraps.find((x) => (x.innerText || '').includes(t));
        if (!card) return { ok: false, reason: 'card not found' };
        let btn = null;
        if (m === 'review') {
          btn = card.querySelector('a.recreation, .showFromBtn, .btn.recreation');
        } else {
          btn = card.querySelector('a.jobExamComBtn, .commonBtn_green, a.commonBtn_green');
        }
        if (!btn) {
          const want = m === 'review' ? /^(申请重做|查看解析|查看)$/ : /^(开始答题)$/;
          btn = [...card.querySelectorAll('a,button')].find((x) => want.test((x.innerText || '').trim().replace(/\s+/g, '')));
        }
        if (!btn) return { ok: false, reason: 'button not found', cardText: (card.innerText || '').slice(0, 200) };
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return { ok: true, tag: btn.tagName, cls: btn.className, text: (btn.innerText || '').trim().slice(0, 20) };
      }, { t: chapter, m: mode }).catch((e) => ({ ok: false, reason: e.message }));
      await sleep(3500);
      if (mode === 'review') {
        const dlg = this.page.locator('.el-message-box__btns button').filter({ hasText: /确定/ }).first();
        for (let k = 0; k < 2; k++) {
          if (await dlg.count().catch(() => 0)) { await dlg.click({ force: true }).catch(() => {}); await sleep(1800); }
        }
      }
      let opened = this.context.pages().filter((p2) => !before.has(p2) && !p2.isClosed());
      // 兜底 1：同页 hash 路由跳转
      if (!opened.length && /dohomework|checkHomework/.test(this.page.url())) {
        await this.page.waitForSelector('.examPaper_subject', { timeout: 20000 }).catch(() => {});
        return { ok: true, chapter, mode, kind: this.page.url().includes('/checkHomework/') ? 'exam-review' : 'exam-answering', url: this.page.url(), via: 'same-page', detail: clicked, tree: await this.pageTree() };
      }
      // 兜底 2：用真实鼠标点击按钮（JS click 可能被拦截）
      if (!opened.length) {
        const btn = this.page.locator('.examItemWrap, .course, li').filter({ hasText: chapter }).first()
          .locator(mode === 'review' ? 'a.recreation, .showFromBtn' : 'a.jobExamComBtn, a.commonBtn_green').first();
        if (await btn.count().catch(() => 0)) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await sleep(500);
          await this.humanClick(btn).catch(async () => { await btn.click({ force: true }).catch(() => {}); });
          await sleep(4000);
          opened = this.context.pages().filter((p2) => !before.has(p2) && !p2.isClosed());
        }
      }
      const target = opened.pop() || this.context.pages().filter((p2) => !p2.isClosed() && /dohomework|checkHomework/.test(p2.url())).pop();
      if (!target) {
        const shot = await this.page.screenshot({ type: 'png' }).catch(() => null);
        const diag = { detail: clicked, url: this.page.url(), iframes: await this.page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src)).catch(() => []), shotBytes: shot ? shot.length : 0 };
        this.log('open_chapter_fail', diag);
        return { ok: false, error: '没有打开测试页', detail: diag, tree: await this.pageTree() };
      }
      await target.waitForLoadState('domcontentloaded').catch(() => {});
      await target.waitForSelector('.examPaper_subject', { timeout: 25000 }).catch(() => {});
      await sleep(1200);
      this.page = target;
      this.page.setDefaultTimeout(15000);
      const kind = target.url().includes('/checkHomework/') ? 'exam-review' : 'exam-answering';
      this.registerPage(target, { label: chapter + ':' + kind });
      this.log('open_chapter', { chapter, mode, kind, url: target.url() });
      return { ok: true, chapter, mode, kind, url: target.url(), detail: clicked, tree: await this.pageTree() };
    }
    if (name === 'goto_url') {
      const guard = this.safeEntryUrl(args.url);
      if (!guard.ok) return { ok: false, error: guard.error, hint: '改用 open_exam_list / open_chapter' };
      await this.page.goto(guard.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(3500);
      this.registerPage(this.page);
      return { ok: true, url: this.page.url() };
    }
    if (name === 'click_nth') {
      const el = this.page.locator(String(args.selector || '')).nth(Number(args.index) || 0);
      if (!(await el.count().catch(() => 0))) return { ok: false, error: 'selector not found' };
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(500);
      const before = new Set(this.context.pages());
      await this.humanClick(el).catch(() => {});
      await sleep(1500);
      const after = this.context.pages().filter((p) => !before.has(p));
      if (!after.length) {
        await el.click({ force: true }).catch(() => {});
        await sleep(1800);
      }
      return { ok: true, url: this.page.url(), pages: this.context.pages().map((p) => p.url()) };
    }
    if (name === 'click_text') {
      const el = this.page.getByText(String(args.text || ''), { exact: true }).first();
      if (!(await el.count().catch(() => 0))) return { ok: false, error: 'text not found' };
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(500);
      await this.humanClick(el);
      await sleep(1500);
      return { ok: true, url: this.page.url() };
    }
    if (name === 'click_selector') { await this.page.locator(args.selector).first().click({ timeout: 6000 }); await sleep(800); return { ok: true }; }
    if (name === 'click_at') { await this.page.mouse.click(Number(args.x) * vp.width, Number(args.y) * vp.height); await sleep(800); return { ok: true }; }
    if (name === 'drag') {
      await this.page.mouse.move(Number(args.from_x) * vp.width, Number(args.from_y) * vp.height);
      await this.page.mouse.down();
      await this.page.mouse.move(Number(args.to_x) * vp.width, Number(args.to_y) * vp.height, { steps: 20 });
      await this.page.mouse.up();
      await sleep(900);
      return { ok: true };
    }
    if (name === 'press_key') { await this.page.keyboard.press(String(args.key)); await sleep(500); return { ok: true }; }
    if (name === 'wait') { await sleep(Math.min(15000, Math.max(200, Number(args.ms) || 1000))); return { ok: true }; }
    if (name === 'open_study_page') { await this.gotoStudy(); await this.prepareCourse(); return { ok: true, videos: this.videos.length, done: this.done }; }
    if (name === 'scan_videos') { await this.prepareCourse(); return { ok: true, videos: this.videos.length, done: this.done, finished: this.videos.filter((v) => v.finished).length }; }
    if (name === 'get_speed') return await this.page.evaluate(() => { const v = document.querySelector('video'); return v ? { rate: v.playbackRate, t: v.currentTime, d: v.duration, paused: v.paused } : null; });
    if (name === 'dismiss_boxes') return { dismissed: await this.dismissMessageBox() };
    if (name === 'solve_quiz') return { solved: await this.solveQuizPopup() };
    if (name === 'list_plugins') { try { return fs.readdirSync(this.pluginsDir).filter((f) => f.endsWith('.js')); } catch { return []; } }
    if (name === 'write_plugin') {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      const safe = String(args.name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'plugin';
      const file = path.join(this.pluginsDir, safe + '.js');
      fs.writeFileSync(file, String(args.code || ''), 'utf8');
      this.log('plugin_written', { name: safe, file });
      return { ok: true, name: safe, file };
    }
    if (name === 'run_plugin') {
      const safe = String(args.name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
      const file = path.join(this.pluginsDir, safe + '.js');
      if (!fs.existsSync(file)) return { ok: false, error: 'plugin not found' };
      try {
        delete require.cache[require.resolve(file)];
        const fn = require(file);
        const result = await fn({ page: this.page, bot: this, sleep, log: (e, x) => this.log(e, x), args: args.args || {} });
        this.log('plugin_run', { name: safe, result: String(JSON.stringify(result)).slice(0, 800) });
        return { ok: true, result };
      } catch (e) {
        this.log('plugin_error', { name: safe, msg: e.message });
        return { ok: false, error: e.message };
      }
    }
    if (name === 'patch_method') {
      const method = String(args.method || '');
      if (!/^[a-zA-Z_$][\w$]*$/.test(method) || method === 'constructor') return { ok: false, error: 'invalid method' };
      try {
        const fn = new Function('return async function(...args){' + String(args.code || '') + '}')();
        const old = this[method];
        let list = [];
        try { list = JSON.parse(fs.readFileSync(this.patchesPath, 'utf8')); } catch {}
        if (!Array.isArray(list)) list = [];
        list = list.filter((x) => x.method !== method);
        list.push({ method, code: String(args.code || ''), at: new Date().toISOString(), old: typeof old === 'function' ? String(old).slice(0, 2000) : '' });
        fs.mkdirSync(path.dirname(this.patchesPath), { recursive: true });
        fs.writeFileSync(this.patchesPath, JSON.stringify(list, null, 2));
        this[method] = fn;
        this.log('patch_written', { method });
        return { ok: true, method };
      } catch (e) {
        this.log('patch_write_error', { method, msg: e.message });
        return { ok: false, error: e.message };
      }
    }
    if (name === 'dump_quiz') return await this.page.evaluate(() => {
      const ds = [...document.querySelectorAll('.el-dialog__wrapper')];
      const d = ds.find((x) => /【(判断题|单选题|多选题)】/.test(x.innerText || ''));
      const msgs = [...document.querySelectorAll('.el-message-box__wrapper')].map((m) => ({ text: (m.innerText || '').replace(/\s+/g, ' ').slice(0, 200), display: getComputedStyle(m).display, visible: m.getBoundingClientRect().width > 0 }));
      if (!d) return { found: false, msgs };
      return {
        found: true,
        text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
        options: [...d.querySelectorAll('.topic-item')].map((li) => ({
          cls: li.className,
          text: (li.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
          icon: li.querySelector('use')?.getAttribute('xlink:href') || '',
          checked: /active|selected|checked/i.test(li.className) || li.querySelector('input:checked') !== null
        })),
        msgs
      };
    });
    if (name === 'set_speed') {
      const rate = Number(args.rate) === 1.5 ? 1.5 : 1;
      const out = await this.page.evaluate((r) => { const v = document.querySelector('video'); if (!v) return null; v.playbackRate = r; return { rate: v.playbackRate, t: v.currentTime, d: v.duration, paused: v.paused }; }, rate);
      this.config.speed = rate;
      this.log('speed_set', out || {});
      return out;
    }
    if (name === 'start_script') { await this.start(); return { ok: true, status: this.status, running: this.running }; }
    if (name === 'pause_script') { await this.pause(); return { ok: true, status: this.status, paused: this.paused }; }
    if (name === 'resume_script') { await this.resume(); return { ok: true, status: this.status, paused: this.paused }; }
    if (name === 'stop_script') { await this.stop(); return { ok: true, status: this.status }; }
    if (name === 'request_human') {
      this.attention = { title: '调试模型请求人工', message: args.reason || '请检查浏览器当前页面。', image: '/api/screenshot?v=' + this.screenshotVersion };
      this.status = 'waiting_human';
      return { ok: true, status: this.status };
    }
    return { ok: false, error: 'unknown tool' };
  }

  async debugChat(message) {
    await this.ensurePage();
    if (!this.config.apiKey) throw new Error('请先在设置里填写 DeepSeek API Key');
    this.log('debug_user', { message });
    const logs = this.logs.slice(-25).map((x) => ({ t: x.t, event: x.event, ...Object.fromEntries(Object.entries(x).filter(([k]) => !['t', 'event'].includes(k))) }));
    const state = await this.pageState();
    const messages = [
      { role: 'system', content: '你是智慧树刷课脚本的调试 Agent。你可以读取页面、点击、拖拽、按键盘、等待，也可以启动/暂停/继续/停止刷课脚本。你有最近两轮操作记忆，先参考 memory 里做过什么、结果如何，避免重复无效动作。只有在用户明确要求时才能操作。优先使用脚本级工具（scan_videos/start_script/pause_script）而不是盲点页面。回答用中文，简要说明你做了什么。' },
      { role: 'user', content: JSON.stringify({ message, page: state, recentLogs: logs, memory: this.memoryContext(), bot: { status: this.status, running: this.running, paused: this.paused, done: this.done, total: this.total }, videoCatalog: this.videos.map((v, i) => ({ index: i, key: v.key, num: v.num, title: v.title, progress: v.progress, finished: v.finished })), completedKeys: this.state.completed || [] }, null, 2) }
    ];
    const tools = this.debugTools();
    const actions = [];
    let answer = '';
    for (let round = 0; round < 6; round++) {
      const data = await chat(this.config, messages, tools, 90000);
      const msg = data.choices?.[0]?.message;
      if (!msg) break;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
        for (const call of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
          let result;
          try { result = await this.runAgentTool(call.function.name, args); }
          catch (e) { result = { ok: false, error: e.message }; }
          actions.push({ tool: call.function.name, args, result });
          this.log('debug_action', { tool: call.function.name, args, result: String(JSON.stringify(result)).slice(0, 500) });
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result).slice(0, 4000) });
        }
        continue;
      }
      answer = msg.content || '';
      break;
    }
    if (!answer) answer = '已执行调试动作。';
    this.log('debug_ai', { answer: answer.slice(0, 1200), actions: actions.length });
    this.lastModel = { at: new Date().toISOString(), kind: 'debug', question: message.slice(0, 180), reason: answer };
    this.rememberAgentTurn({ source: 'debug', message, tools: actions.map((a) => ({ tool: a.tool, args: a.args, result: String(JSON.stringify(a.result)).slice(0, 500) })), answer: answer.slice(0, 800) });
    return { answer, actions };
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
    const ts = this.ensureTimer();
    if (ts.seconds >= ts.limit && !ts.notified) {
      ts.notified = true;
      try { fs.writeFileSync(this.timerPath, JSON.stringify(ts, null, 2)); } catch {}
      this.status = 'daily_limit';
      this.attention = { title: '今日 25 分钟已完成', message: '今天已达到 25 分钟学习时长，脚本已停止。你可以选择继续观看。', image: '/api/screenshot?v=' + this.screenshotVersion };
      this.log('daily_limit_block_start', { seconds: ts.seconds, limit: ts.limit });
      return this.getStatus();
    }
    this.attention = null;
    this.stopRequested = false;
    this.paused = false;
    this.startedAt = new Date().toISOString();
    this.running = true;
    this.status = 'running';
    this.startWatchdog();
    this.loopPromise = this.runLoop().catch((e) => {
      this.running = false;
      if (e.code === 'STOP') { this.status = 'stopped'; this.log('stopped'); }
      else if (e.code === 'LOGIN') { this.status = 'login_required'; this.loggedIn = false; this.log('login_required', { msg: e.message }); }
      else if (e.code === 'DAILY_LIMIT') { this.status = 'daily_limit'; this.log('daily_limit_stopped'); }
      else { this.status = 'error'; this.log('fatal', { msg: e.message, stack: e.stack }); }
    });
    return this.getStatus();
  }

  async pause() { if (this.running) { this.paused = true; this.status = 'paused'; this.log('paused'); } }
  async resume() { this.paused = false; this.status = 'running'; this.pauseResolver?.(); this.pauseResolver = null; this.log('resumed'); }
  async stop() { this.stopRequested = true; if (this.watchdog) clearInterval(this.watchdog); this.watchdog = null; this.paused = false; this.pauseResolver?.(); this.pauseResolver = null; this.log('stop_requested'); }

  async checkpoint() {
    if (this.stopRequested) throw Object.assign(new Error('已停止'), { code: 'STOP' });
    while (this.paused && !this.stopRequested) await new Promise((r) => { this.pauseResolver = r; });
    if (this.stopRequested) throw Object.assign(new Error('已停止'), { code: 'STOP' });
  }

  async autoDebugModel(error, index, video) {
    if (!this.config.apiKey) return null;
    try {
      const state = await this.pageState();
      const logs = this.logs.slice(-35).map((x) => ({ t: x.t, event: x.event, msg: x.msg || x.error || x.reason || '' }));
      const data = await chat(this.config, [
        { role: 'system', content: '你是智慧树刷课脚本的自主修复 Agent。你有最近两轮操作记忆，先参考 memory 中已经尝试过什么、结果如何，不要重复无效动作。根据错误、页面和日志选择一个恢复动作。只返回 JSON：{"action":"retry|reload|reopen_course|dismiss_dialog|solve_quiz|request_human|next_video","reason":"简短理由"}。优先 retry/reload/reopen_course；答题弹窗用 solve_quiz；确实无法判断才 request_human。' },
        { role: 'user', content: JSON.stringify({ error: error?.message || String(error), index, video: video ? { num: video.num, title: video.title } : null, status: this.status, page: state, recentLogs: logs, memory: this.memoryContext() }, null, 2) }
      ], null, 30000);
      const text = data.choices?.[0]?.message?.content || '';
      const m = text.match(/"action"\s*:\s*"([^"]+)"/);
      const action = m ? m[1] : '';
      this.log('auto_debug_model', { index, action, reason: text.slice(0, 300) });
      this.rememberAgentTurn({ source: 'autoheal', error: error?.message || String(error), index, action, reason: text.slice(0, 500) });
      return action || null;
    } catch (e) {
      this.log('auto_debug_model_error', { msg: e.message });
      return null;
    }
  }

  contextAround(entry, count = 35) {
    const idx = this.logs.findIndex((x) => x === entry || (x.t === entry.t && x.event === entry.event));
    if (idx < 0) return this.logs.slice(-count);
    const half = Math.floor(count / 2);
    let start = Math.max(0, idx - half);
    if (start + count > this.logs.length) start = Math.max(0, this.logs.length - count);
    return this.logs.slice(start, start + count);
  }

  async runIncident() {
    this.ensureRuntimeState();
    if (this.inIncident || !this.pendingIncident) return;
    const entry = this.pendingIncident;
    this.pendingIncident = null;
    this.inIncident = true;
    try {
      fs.mkdirSync(this.incidentDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.join(this.incidentDir, 'incident-' + stamp);
      const shotPath = base + '.png';
      await this.page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
      const logs = this.contextAround(entry, 35);
      fs.writeFileSync(base + '.json', JSON.stringify({ at: new Date().toISOString(), trigger: entry, logs, screenshot: shotPath }, null, 2));
      this.log('incident_captured', { trigger: entry.event, screenshot: shotPath, logFile: base + '.json', contextCount: logs.length, triggerAt: entry.t });
      const index = Number.isInteger(entry.index) ? entry.index : -1;
      const err = new Error(entry.event + ': ' + (entry.msg || entry.reason || ''));
      // 硬性规定：每次 incident 必须推到调试 Agent，直到脚本重新接管或明确需要人工
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (await this.scriptTakeover()) {
          this.log('incident_script_takeover', { attempt, trigger: entry.event });
          return;
        }
        if (await this.isHumanVerification()) {
          this.log('incident_captcha_agent', { attempt });
          await this.handleHumanVerification();
          await sleep(1000);
          if (await this.scriptTakeover()) { this.log('incident_script_takeover', { attempt, trigger: entry.event }); return; }
          continue;
        }
        this.log('incident_agent_attempt', { attempt, trigger: entry.event });
        await this.autoAgent(err, index, { screenshotPath: shotPath, logs, trigger: entry, attempt });
        await sleep(2500);
        if (await this.scriptTakeover()) {
          this.log('incident_script_takeover', { attempt, trigger: entry.event });
          return;
        }
        if (this.status === 'waiting_human') return;
        this.log('incident_retry', { attempt, trigger: entry.event });
      }
      this.attention = { title: '自主调试未接管', message: '调试 Agent 连续尝试 5 次仍未恢复脚本。请检查页面后点“我已处理，继续”。', image: '/api/screenshot?v=' + this.screenshotVersion };
      this.status = 'waiting_human';
      await this.waitHuman();
    } finally {
      this.inIncident = false;
    }
  }

  async scriptTakeover() {
    if (this.stopRequested) return true;
    if (this.status === 'waiting_human' || this.status === 'login_required') return false;
    if (!this.page || this.page.isClosed()) return false;
    if (!this.isStudyUrl(this.page.url())) return false;
    if (await this.isHumanVerification().catch(() => false)) return false;
    if (await this.isQuizPopup().catch(() => false)) return false;
    const n = await this.page.locator('.el-message-box__wrapper').count().catch(() => 0);
    if (n) {
      const vis = await this.page.locator('.el-message-box__wrapper').first().isVisible().catch(() => false);
      if (vis) return false;
    }
    return !this.paused;
  }

  async autoAgent(error, index, incident = {}) {
    if (!this.config.apiKey) return null;
    const allowed = ['get_page_state', 'dump_quiz', 'dismiss_boxes', 'solve_quiz', 'scan_videos', 'open_study_page', 'request_human', 'wait', 'list_plugins', 'write_plugin', 'run_plugin', 'patch_method'];
    const tools = this.debugTools().filter((t) => allowed.includes(t.function.name));
    const state = await this.pageState();
    const logs = this.logs.slice(-35).map((x) => ({ t: x.t, event: x.event, msg: x.msg || x.error || x.reason || '' }));
    const messages = [
      { role: 'system', content: '你是智慧树刷课脚本的自主修复 Agent。你有最近两轮操作记忆，先看 memory 里试过什么，不要重复。你可以检查页面、导出弹题、关闭提示框、处理弹题、重新扫描/打开课程页、等待或请求人工。你还可以写新的浏览器插件（write_plugin/run_plugin）来支持页面操作，或 patch_method 永久调整内部方法；优先用插件，补丁只用于可复用的逻辑修复。不要点击视频目录，不要启动/停止脚本。根据错误选择工具，尽量自己修好。' },
      { role: 'user', content: JSON.stringify({ error: error?.message || String(error), index, memory: this.memoryContext(), status: this.status, page: state, recentLogs: logs, screenshot: incident.screenshotPath || null, trigger: incident.trigger || null, incidentLogs: incident.logs ? incident.logs.slice(-20) : null }, null, 2) }
    ];
    const actions = [];
    let answer = '';
    for (let round = 0; round < 4; round++) {
      let data;
      try { data = await chat(this.config, messages, tools, 60000); }
      catch (e) { this.log('auto_agent_chat_error', { msg: e.message }); break; }
      const msg = data.choices?.[0]?.message;
      if (!msg) break;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
        for (const call of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
          let result;
          try { result = await this.runAgentTool(call.function.name, args); }
          catch (e) { result = { ok: false, error: e.message }; }
          actions.push({ tool: call.function.name, args, result });
          this.log('auto_agent_action', { tool: call.function.name, args, result: String(JSON.stringify(result)).slice(0, 500) });
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result).slice(0, 3000) });
        }
        continue;
      }
      answer = msg.content || '';
      break;
    }
    this.log('auto_agent_done', { error: error?.message || String(error), actions: actions.length, answer: answer.slice(0, 500) });
    this.rememberAgentTurn({ source: 'autoagent', error: error?.message || String(error), index, tools: actions.map((a) => ({ tool: a.tool, result: String(JSON.stringify(a.result)).slice(0, 500) })), answer: answer.slice(0, 500) });
    return { actions, answer };
  }

  async autoHeal(error, index, video) {
    this.ensureRuntimeState();
    if (this.config.autoDebug === false) return 'retry';
    const key = video?.key || ('v' + index);
    const attempt = (this.autoHealAttempts.get(key) || 0) + 1;
    this.autoHealAttempts.set(key, attempt);
    this.lastHeal = { at: new Date().toISOString(), index, attempt, error: error?.message || String(error) };
    this.log('auto_heal_start', { index, attempt, error: error?.message || String(error) });

    await this.dismissMessageBox().catch(() => {});
    if (await this.isQuizPopup()) await this.solveQuizPopup().catch(() => {});
    if (await this.isHumanVerification()) { await this.handleHumanVerification(); return 'retry'; }

    const ok = await this.recoverToStudy('auto_heal');
    if (ok) {
      await sleep(1200);
      await this.scanVideos().catch(() => {});
      if (this.videos[index]?.finished) { this.log('auto_heal_done', { index, attempt }); return 'retry'; }
      const marked = await this.waitForCheckmark(index, 15000).catch(() => false);
      if (marked) { await this.scanVideos().catch(() => {}); this.log('auto_heal_mark', { index, attempt }); return 'retry'; }
    }

    if (attempt <= 3) {
      this.log('auto_heal_retry', { index, attempt });
      return 'retry';
    }

    const agent = await this.autoAgent(error, index).catch((e) => { this.log('auto_agent_error', { msg: e.message }); return null; });
    if (this.status === 'waiting_human') { await this.waitHuman(); this.autoHealAttempts.set(key, 0); return 'retry'; }
    if (agent?.actions?.length) return 'retry';
    const action = await this.autoDebugModel(error, index, video);
    if (action === 'solve_quiz') { await this.solveQuizPopup().catch(() => {}); return 'retry'; }
    if (action === 'dismiss_dialog') { await this.dismissMessageBox().catch(() => {}); return 'retry'; }
    if (action === 'reload') {
      await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(4000);
      await this.recoverToStudy('auto_heal_reload').catch(() => {});
      return 'retry';
    }
    if (action === 'next_video') {
      const next = this.videos.findIndex((x, j) => j > index && !x.finished);
      this.log('auto_heal_next', { index, next });
      return next >= 0 ? 'next' : 'retry';
    }
    if (action === 'request_human' || attempt >= 5) {
      this.attention = { title: '自主修复失败', message: '脚本连续尝试恢复失败：' + (error?.message || error) + '。请检查页面后点“我已处理，继续”。', image: '/api/screenshot?v=' + this.screenshotVersion };
      this.log('auto_heal_human', { index, attempt });
      await this.waitHuman();
      this.autoHealAttempts.set(key, 0);
      return 'retry';
    }
    this.log('auto_heal_retry_model', { index, attempt, action });
    return 'retry';
  }

  async openTest(index) {
    await this.ensureStudyPage();
    const before = new Set(this.context.pages());
    const item = this.page.locator('li.chapter-test').nth(Number(index) || 0);
    await item.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(500);
    await this.humanClick(item).catch(async () => { await item.click({ force: true }).catch(() => {}); });
    await sleep(4000);
    const after = this.context.pages().filter((p) => !before.has(p));
    if (after.length) { this.page = after[after.length - 1]; await this.page.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(2500); }
    return await this.pageState();
  }

  async examQuestions() {
    return await this.page.evaluate(() => [...document.querySelectorAll('.examPaper_subject')].map((q, i) => {
      const typeText = (q.querySelector('.subject_type')?.innerText || '').trim();
      const stem = (q.querySelector('.subject_describe')?.innerText || '').replace(/\s+/g, ' ').trim();
      const options = [...q.querySelectorAll('.nodeLab')].map((n) => (n.innerText || '').replace(/^\s*[A-E][.、]\s*/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return { i, type: /多选/.test(typeText) ? 'checkbox' : 'radio', typeText, stem, options };
    }));
  }

  async applyExamOption(qIndex, wanted) {
    const readState = async () => this.page.evaluate((idx) => {
      const blocks = [...document.querySelectorAll('.examPaper_subject')];
      const b = blocks[idx] || blocks.find((x) => x.offsetParent !== null);
      if (!b) return null;
      const rows = [...b.querySelectorAll('.nodeLab')];
      return rows.map((n) => ({
        text: (n.querySelector('.node_detail')?.innerText || n.innerText || '').replace(/^\s*[A-E][.、]\s*/, '').replace(/\s+/g, ' ').trim(),
        checked: Boolean(n.querySelector('.node_detail.onChecked')) || Boolean(n.querySelector('input:checked')) || /onChecked/.test(n.innerHTML)
      }));
    }, qIndex).catch(() => null);

    let state = await readState();
    if (!state) return { ok: false, state: null, reason: 'block-not-found' };

    const match = () => state.every((row, j) => Boolean(row.checked) === wanted.has(j));

    for (let attempt = 0; attempt < 3; attempt++) {
      if (match()) return { ok: true, state, attempts: attempt };
      for (let j = 0; j < state.length; j++) {
        if (Boolean(state[j].checked) === wanted.has(j)) continue;
        const rows = this.page.locator('.examPaper_subject').nth(qIndex).locator('.nodeLab');
        const row = rows.nth(j);
        await row.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(200);
        // 1) 人类式点击整行
        await this.humanClick(row).catch(() => {});
        await sleep(400);
        state = await readState();
        if (!state) return { ok: false, state: null, reason: 'state-lost' };
        if (Boolean(state[j].checked) === wanted.has(j)) continue;
        // 2) 点击选项圆圈区域（左侧 20px）
        const box = await row.boundingBox().catch(() => null);
        if (box) {
          await this.page.mouse.move(box.x + 12, box.y + box.height / 2, { steps: 3 }).catch(() => {});
          await sleep(120);
          await this.page.mouse.down().catch(() => {});
          await sleep(80);
          await this.page.mouse.up().catch(() => {});
          await sleep(400);
          state = await readState();
          if (state && Boolean(state[j].checked) === wanted.has(j)) continue;
        }
        // 3) 直接派发事件 + 点内层文字
        await row.evaluate((n) => {
          const inner = n.querySelector('.node_detail') || n;
          inner.click();
          n.click();
        }).catch(() => {});
        await sleep(400);
        state = await readState();
        this.log('exam_option_retry', { index: qIndex, option: j, want: wanted.has(j), now: state ? Boolean(state[j].checked) : null, attempt });
      }
      state = await readState();
      if (state && match()) return { ok: true, state, attempts: attempt + 1 };
    }
    return { ok: false, state, reason: 'mismatch-after-retries' };
  }

  // 按内容定位并点击，避免下标错位
  async applyExamOptionByText(wantedIdx, texts) {
    const wantTextSet = new Set([...wantedIdx].map((i) => texts[i]));
    const readReal = async () => this.page.evaluate(() => {
      const CHECKED = '134c9fe76fac4b76ace068fdc8b95f07';
      const blocks = [...document.querySelectorAll('.examPaper_subject')];
      const b = blocks.find((x) => x.offsetParent !== null);
      if (!b) return null;
      return [...b.querySelectorAll('.nodeLab')].map((n) => {
        const img = n.querySelector('img');
        const src = img ? (img.getAttribute('src') || '') : '';
        const input = n.querySelector('input');
        return {
          text: (n.querySelector('.node_detail')?.innerText || n.innerText || '').replace(/^\s*[A-E][.、]\s*/, '').replace(/\s+/g, ' ').trim(),
          checked: src.includes(CHECKED) || (input ? input.checked : false) || /onChecked/i.test(n.querySelector('.node_detail')?.className || '')
        };
      });
    }).catch(() => null);
    let st = await readReal();
    if (!st) return { ok: false, state: null };
    const match = (s) => s.length === texts.length && s.every((row) => wantTextSet.has(row.text) === row.checked);

    for (let attempt = 0; attempt < 3; attempt++) {
      if (match(st)) return { ok: true, state: st, attempts: attempt };
      for (let j = 0; j < st.length; j++) {
        const shouldCheck = wantTextSet.has(st[j].text);
        if (st[j].checked === shouldCheck) continue;
        // 必须定位到「当前可见」的 block，隐藏 block 点击无效
        const visibleIdx = await this.visibleBlockIndex();
        if (visibleIdx < 0) return { ok: false, state: st, reason: 'no-visible-block' };
        const row = this.page.locator('.examPaper_subject').nth(visibleIdx).locator('.nodeLab').nth(j);
        await row.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(180);
        await this.humanClick(row).catch(() => {});
        await sleep(380);
        st = await readReal();
        if (!st) return { ok: false, state: null };
        if (st[j] && st[j].checked === shouldCheck) continue;
        // 点击圆圈
        const box = await row.boundingBox().catch(() => null);
        if (box) {
          await this.page.mouse.move(box.x + 14, box.y + box.height / 2, { steps: 3 }).catch(() => {});
          await sleep(100);
          await this.page.mouse.down().catch(() => {});
          await sleep(70);
          await this.page.mouse.up().catch(() => {});
          await sleep(380);
          st = await readReal();
          if (st && st[j] && st[j].checked === shouldCheck) continue;
        }
        await row.evaluate((n) => { (n.querySelector('.node_detail') || n).click(); n.click(); }).catch(() => {});
        await sleep(380);
        st = await readReal();
        this.log('exam_option_retry', { option: j, want: shouldCheck, now: st && st[j] ? st[j].checked : null, attempt });
      }
      st = await readReal();
      if (st && match(st)) return { ok: true, state: st, attempts: attempt + 1 };
    }
    return { ok: false, state: st };
  }

  async readAnswerCard() {
    return await this.page.evaluate(() => {
      const items = [...document.querySelectorAll('.answerCard_list li')];
      return items.map((n, i) => ({ i, text: (n.innerText || '').trim(), cls: String(n.className || '') }));
    }).catch(() => []);
  }

  async visibleBlockIndex() {
    return await this.page.evaluate(() => [...document.querySelectorAll('.examPaper_subject')].findIndex((x) => x.offsetParent !== null)).catch(() => -1);
  }

  // 必须确认「可见 block」真的切到了第 i 题，否则重试
  async gotoQuestion(i, tries = 4) {
    const li = this.page.locator('.answerCard_list li').nth(i);
    if (!(await li.count().catch(() => 0))) return false;
    for (let k = 0; k < tries; k++) {
      if ((await this.visibleBlockIndex()) === i) return true;
      await li.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(150);
      await li.click({ force: true }).catch(() => {});
      await sleep(600);
      let idx = await this.visibleBlockIndex();
      if (idx === i) return true;
      // 兜底：滚到题目区再点一次
      await this.page.mouse.wheel(0, 200).catch(() => {});
      await sleep(200);
      await li.click({ force: true }).catch(() => {});
      await sleep(700);
      idx = await this.visibleBlockIndex();
      if (idx === i) return true;
      this.log('goto_question_retry', { want: i, got: idx, attempt: k });
    }
    return false;
  }

  // 选中态真实来源：img 图标。
  //   e777864... = 未选中  134c9fe... = 已选中
  async readCurrentSelection() {
    return await this.page.evaluate(() => {
      const CHECKED = '134c9fe76fac4b76ace068fdc8b95f07';
      const blocks = [...document.querySelectorAll('.examPaper_subject')];
      const b = blocks.find((x) => x.offsetParent !== null);
      if (!b) return null;
      const rows = [...b.querySelectorAll('.nodeLab')];
      const texts = rows.map((n) => (n.querySelector('.node_detail')?.innerText || n.innerText || '').replace(/^\s*[A-E][.、]\s*/, '').replace(/\s+/g, ' ').trim());
      const checked = rows.map((n) => {
        const img = n.querySelector('img');
        const src = img ? (img.getAttribute('src') || '') : '';
        const input = n.querySelector('input');
        const cls = (n.querySelector('.node_detail')?.className || '') + ' ' + (n.className || '');
        return src.includes(CHECKED)
          || (input ? input.checked : false)
          || /onChecked|is-checked|active/i.test(cls);
      });
      return { texts, checked, visibleIdx: blocks.indexOf(b) };
    }).catch(() => null);
  }

  // 逐题翻页复核：plan = [{ i, want:[正确文本...] }]
  async verifyExamSelection(_qs, plan) {
    const out = [];
    for (const { i, want } of plan) {
      const ok = await this.gotoQuestion(i);
      if (!ok) { out.push({ i, ok: false, reason: 'card-missing' }); continue; }
      const cur = await this.readCurrentSelection();
      if (!cur) { out.push({ i, ok: false, reason: 'dom-missing' }); continue; }
      const gotTexts = cur.texts.filter((_, j) => cur.checked[j]);
      const wantSet = [...(want || [])].map((x) => String(x).replace(/\s+/g, '')).sort();
      const gotSet = gotTexts.map((x) => String(x).replace(/\s+/g, '')).sort();
      const okNow = wantSet.length === gotSet.length && wantSet.every((v, k) => v === gotSet[k]);
      out.push({ i, ok: okNow, want: wantSet.map((x) => x.slice(0, 12)).join(' | '), got: gotSet.map((x) => x.slice(0, 12)).join(' | ') });
    }
    await this.gotoQuestion(0).catch(() => {});
    return out;
  }

  async solveExam(opts = {}) {
    const dryRun = Boolean(opts.dryRun);
    const bankOnly = opts.bankOnly !== false; // 默认纯题库，不依赖模型
    if (this.examRunning) return { busy: true, questions: 0 };
    this.examRunning = true;
    try {
    const pages = this.context?.pages() || [];
    let exam = (this.page && !this.page.isClosed() && this.page.url().includes('/dohomework/')) ? this.page : pages.filter((p) => !p.isClosed() && p.url().includes('/dohomework/')).pop();
    if (!exam) exam = pages.filter((p) => !p.isClosed() && p.url().includes('/dohomework/')).pop();
    if (!exam) exam = pages.find((p) => !p.isClosed() && p.url().includes('onlineexamh5new.zhihuishu.com'));
    if (!exam) throw new Error('没有打开考试页');
    this.page = exam;
    this.page.setDefaultTimeout(15000);
    await this.page.waitForSelector('.examPaper_subject', { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    const report = [];
    this.examMissing = [];
    this.examPlan = [];
    const examId = this.currentExamId();
    // 题数以答题卡为准（DOM 只渲染当前题，block 下标不可信）
    const card = await this.readAnswerCard();
    const total = card.length || (Number((await this.page.evaluate(() => document.querySelector('.examPaper_partTit')?.innerText || '')).match(/总题数[:：]\s*(\d+)/)?.[1]) || 0);
    if (!total) { this.log('exam_no_questions', { url: exam.url() }); throw new Error('考试页没有识别到题目'); }
    this.log('exam_start', { url: exam.url(), questions: total, card: card.length, examId });

    for (let qi = 0; qi < total; qi++) {
      this.status = 'exam';
      let okNav = await this.gotoQuestion(qi);
      if (!okNav) { await sleep(500); okNav = await this.gotoQuestion(qi, 6); }
      if (!okNav) { this.log('exam_nav_failed', { index: qi, got: await this.visibleBlockIndex() }); this.examMissing.push({ i: qi, reason: 'nav-failed' }); continue; }
      const cur = await this.readCurrentSelection();
      if (!cur || !cur.texts.length) { this.log('exam_block_missing', { index: qi }); this.examMissing.push({ i: qi, reason: 'block-missing' }); continue; }
      const question = (await this.page.evaluate(() => {
        const blocks = [...document.querySelectorAll('.examPaper_subject')];
        const b = blocks.find((x) => x.offsetParent !== null) || blocks[0];
        return (b?.querySelector('.subject_describe')?.innerText || '').replace(/\s+/g, ' ').trim();
      }).catch(() => '')) || '（题干为图片/动态文本，请根据截图和选项作答）';
      const type = (await this.page.evaluate(() => {
        const blocks = [...document.querySelectorAll('.examPaper_subject')];
        const b = blocks.find((x) => x.offsetParent !== null) || blocks[0];
        return (b?.querySelector('.subject_type')?.innerText || '').trim();
      }).catch(() => '')).includes('多选') ? 'checkbox' : 'radio';

      this.currentCourse = { userCourseId: 'exam:' + qi, resourceName: '第' + (qi + 1) + '题 ' + (cur.texts[0] || '') };
      let decision = this.lookupExamAnswer(examId, qi, cur.texts, type) || this.lookupQuiz('chapter', question, cur.texts, type);
      if (!decision && !bankOnly) {
        try {
          const shot = await this.page.screenshot({ type: 'png' });
          const visionDecision = await decideQuizVision({ config: this.config, screenshotBase64: shot.toString('base64'), question, options: cur.texts, type, log: (e, d) => this.log(e, d) });
          decision = visionDecision;
        } catch (e) { this.log('exam_model_error', { index: qi, msg: e.message }); }
      }
      if (!decision?.indexes?.length) {
        this.log('exam_no_answer', { index: qi, question: question.slice(0, 120), options: cur.texts });
        if (dryRun) { report.push({ i: qi, status: 'no-bank-answer', question, options: cur.texts }); continue; }
        this.examMissing.push({ i: qi, question, options: cur.texts, type });
        continue;
      }
      this.log('exam_answer', { index: qi, picked: decision.indexes, source: decision.source, question: question.slice(0, 100) });
      this.examPlan.push({ i: qi, indexes: decision.indexes, want: decision.indexes.map((x) => cur.texts[x]) });
      if (dryRun) {
        report.push({ i: qi, status: 'bank-hit', picked: decision.indexes.map((x) => cur.texts[x]), source: decision.source });
        continue;
      }
      // 按内容定位目标行（不用旧下标，行序也可能变）
      const wantTexts = decision.indexes.map((x) => cur.texts[x]);
      const wanted = new Set(wantTexts.map((w) => cur.texts.indexOf(w)).filter((x) => x >= 0));
      const applied = await this.applyExamOptionByText(wanted, cur.texts);
      if (!applied.ok) {
        this.log('exam_option_apply_failed', { index: qi, want: [...wanted], state: applied.state });
        this.examMissing.push({ i: qi, question, options: cur.texts, type, reason: 'click-failed' });
        continue;
      }
      await this.saveQuizAnswer('chapter', question, cur.texts, type, decision.indexes, { examId, examIndex: qi, source: decision.source });
    }
    if (dryRun) {
      this.log('exam_dry_run', { questions: total, bankHit: report.filter((x) => x.status === 'bank-hit').length, missing: this.examMissing.length });
      return { dryRun: true, questions: total, report, missing: this.examMissing };
    }
    if (this.examMissing?.length) {
      this.log('exam_blocked_missing', { count: this.examMissing.length });
      return { questions: total, report, blocked: true, missing: this.examMissing };
    }
    // 提交前逐题复核选中态，任何不一致都不提交
    const plan = (this.examPlan || []).map((x) => ({ i: x.i, want: x.want || [] }));
    if (plan.length !== total) {
      this.log('exam_precheck_incomplete', { plan: plan.length, questions: total });
      this.status = 'ready';
      this.currentCourse = null;
      return { questions: total, blocked: true, reason: 'precheck-incomplete', plan: plan.length };
    }
    const check = await this.verifyExamSelection([], plan);
    const bad = check.filter((x) => !x.ok);
    if (bad.length) {
      this.log('exam_precheck_failed', { bad });
      this.status = 'ready';
      this.currentCourse = null;
      return { questions: total, report, blocked: true, precheckFailed: bad };
    }
    this.log('exam_precheck_ok', { count: check.length });
    const submit = this.page.getByText('提交作业', { exact: true }).first();
    if (await submit.count().catch(() => 0) && await submit.isVisible().catch(() => false)) {
      await this.humanClick(submit).catch(() => {});
      await sleep(800);
      const ok = this.page.getByText('确定', { exact: true }).first();
      if (await ok.count().catch(() => 0)) await this.humanClick(ok).catch(() => {});
      this.log('exam_submitted', { questions: total });
    }
    this.status = 'ready';
    this.currentCourse = null;
    return { questions: total, report, submitted: true };
    } finally {
      this.examRunning = false;
    }
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
    this.log('run_start', { total: this.videos.length, finished: this.videos.filter((v) => v.finished).length, startIndex: this.startIndex });
    let i = Number.isInteger(this.startIndex) ? this.startIndex : this.videos.findIndex((v) => !v.finished);
    this.startIndex = null;
    while (i >= 0 && i < this.videos.length) {
      await this.checkpoint();
      const v = this.videos[i];
      if (!v || v.finished) { i = this.videos.findIndex((x) => !x.finished); continue; }
      this.currentCourse = { userCourseId: 'v' + i, resourceName: v.num + ' ' + v.title };
      this.status = 'running';
      this.saveState();
      this.log('video_begin', { index: i, num: v.num, title: v.title });
      try {
        await this.clickVideo(i);
        const ended = await this.playCurrent(i);
        if (!ended) throw new Error('视频没有自然播放结束');
        // 关键：以页面上的对勾为准，而不是只看 currentTime
        const marked = await this.waitForCheckmark(i, 30000);
        if (!marked) {
          this.log('checkmark_missing', { index: i, num: v.num });
          const heal = await this.autoHeal(new Error('视频播完但没有完成标记：' + v.num + ' ' + v.title), i, v);
          if (heal === 'next') {
            const next = this.videos.findIndex((x, j) => j > i && !x.finished);
            if (next >= 0) { i = next; continue; }
          }
          continue;
        }
        this.videos[i].finished = true;
        this.done = this.videos.filter((x) => x.finished).length;
        this.state.completed = [...new Set([...(this.state.completed || []), this.videos[i].key || ('v' + i)])];
        this.state.forcePending = (this.state.forcePending || []).filter((k) => k !== (this.videos[i].key || ('v' + i)));
        this.saveState();
        this.log('video_done', { index: i, num: v.num, done: this.done, total: this.total });
        await this.capture();
        // 出现对勾后，调用一次模型对齐下一条
        const next = await this.alignNextVideo(i);
        if (next < 0 || next === i) break;
        this.log('align_next_click', { from: i, to: next });
        i = next;
      } catch (e) {
        if (e.code === 'STOP' || e.code === 'LOGIN' || e.code === 'DAILY_LIMIT') throw e;
        this.log('video_error', { index: i, num: v.num, msg: e.message });
        try {
          const decision = await this.autoHeal(e, i, v);
          if (decision === 'next') {
            const next = this.videos.findIndex((x, j) => j > i && !x.finished);
            this.log('auto_heal_skip_to', { from: i, to: next });
            if (next >= 0) { i = next; continue; }
          }
          continue;
        } catch (healErr) {
          this.log('auto_heal_fatal', { msg: healErr.message, original: e.message });
          throw e;
        }
      }
    }
    this.status = 'done';
    this.running = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.currentCourse = null;
    this.saveState();
    this.log('all_videos_done', { done: this.done, total: this.total });
  }

  async capture() {
    if (!this.page || this.page.isClosed()) return;
    try {
      await this.page.screenshot({ path: path.join(this.shotsDir, 'current.png'), fullPage: false });
      this.screenshotVersion++;
    } catch {}
  }
}

module.exports = { Bot };

// ==== 公开 API（供 CLI / 外部调度使用）====
class ZhihuishuBot extends Bot {
  // 打开作业考试列表（从学习页点进去，唯一可靠入口）
  async openExamList() { return await this.runAgentTool('open_exam_list', {}); }

  // 打开指定章节测试：name 例如 "第五章单元测试"
  async openChapter(name, mode = 'start') { return await this.runAgentTool('open_chapter', { chapter: name, mode }); }

  // 纯题库试跑：不点不提交，只回命中情况
  async dryRun() { return await this.solveExam({ dryRun: true, bankOnly: true }); }

  // 正式作答并提交（内部含逐题复核，不一致拒绝提交）
  async solve() { return await this.solveExam({ dryRun: false, bankOnly: true }); }

  // 题库操作
  async bankUpsert(payload) { return await this.runAgentTool('bank_upsert', payload); }
  async bankVerify(examId) { return await this.runAgentTool('bank_verify', { examId }); }
  async bankShow(examId) { return await this.runAgentTool('bank_show', { examId }); }

  // 只读扒题：逐题翻页取题干与选项（不选不提交）
  async dumpAll() { return await this.runAgentTool('exam_dump_all', {}); }
  async goToQuestion(n) { return await this.runAgentTool('goto_question', { n }); }

  // 标签页管理（不重启浏览器）
  async pages() { return await this.pageTree(); }
  async focus(id) { return await this.focusPageById(id); }
  async dedupe() { return await this.runAgentTool('pages_dedupe', {}); }
}
module.exports.ZhihuishuBot = ZhihuishuBot;
module.exports.summary = (rootDir) => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(rootDir || path.join(__dirname, '..'), 'data', 'exam-summary.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
