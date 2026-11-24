'use strict';
/**
 * 智慧树适配器（参考实现）
 *
 * 本文件是「填充完整的样板」：所有选择器与方法都来自实测。
 * 移植新站点时，对照本文件写自己的适配器，重点看：
 *   - selectors 每一项为什么这么写
 *   - readChecked 为什么读 img.src（第 5 节）
 *   - gotoQuestion 为什么要验证可见块下标（第 6 节）
 *   - getExamId 为什么必须完整（第 4.2 节）
 *
 * 实现方式：薄封装，内部转调 lib/bot.js 的既有方法。
 * 新站点应该**独立实现**，不要经过 bot.js（那是智慧树专用引擎）。
 */

const SELECTORS = {
  // ---- 单元列表 ----
  unitItem: 'li.video',
  unitTitle: '.catalogue_title',
  unitDone: '.time_icofinish',

  // ---- 题目 ----
  questionBlock: '.examPaper_subject',
  questionStem: '.subject_describe',
  questionType: '.subject_type',
  optionRow: '.nodeLab',
  optionText: '.node_detail',
  optionIcon: 'img',

  // ---- 答题卡 / 题头 ----
  answerCard: '.answerCard_list li',
  partTitle: '.examPaper_partTit',

  // ---- 导航 ----
  prevBtn: '.switch-btn-box button:nth-of-type(1)',
  nextBtn: '.switch-btn-box button:nth-of-type(2)',
  submitBtn: '提交作业',

  // ---- 解析页 ----
  reviewBlock: '.examPaper_subject',
};

module.exports = {
  name: 'zhihuishu',
  displayName: '智慧树',
  origin: 'https://studyvideoh5.zhihuishu.com',
  selectors: SELECTORS,

  // 选中态特征串：页面不加 onChecked 类，状态只在图标 src 上
  //   134c9fe76fac4b76ace068fdc8b95f07 = 已选中
  //   e777864488a343b28e258392fd6a28dc = 未选中
  selectedMarker: '134c9fe76fac4b76ace068fdc8b95f07',
  unselectedMarker: 'e777864488a343b28e258392fd6a28dc',

  // ============ L1 浏览器 ============
  async launch(ctx) {
    const { chromium } = require('playwright-core');
    const context = await chromium.launchPersistentContext(ctx.profileDir, {
      channel: ctx.browserChannel || 'msedge',
      headless: Boolean(ctx.headless),
      viewport: { width: 1440, height: 1000 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling'],
    });
    return context;
  },

  async isLoggedIn(page) {
    const url = page.url();
    if (/login|passport|oauth|sso/i.test(url)) return false;
    const body = await page.locator('body').innerText({ timeout: 4000 }).catch(() => '');
    if (/登录中心|学号登录|账号登录|扫码登录/.test(body)) return false;
    return /我的课程|共享课|课程学习|在线学堂|我的学堂/.test(body) || url.includes('stuStudy');
  },

  async gotoStudy(page) {
    const url = 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=4e5e5c58415e4859454a585959455c435a';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
  },

  // ============ 单元 ============
  async listUnits(page) {
    return await page.evaluate((sel) => {
      return [...document.querySelectorAll(sel.unitItem)].map((li, index) => {
        const title = (li.querySelector(sel.unitTitle)?.innerText || '').replace(/\s+/g, ' ').trim();
        const numEl = li.querySelector('.catalogue_title')?.previousElementSibling;
        const num = (numEl?.innerText || '').trim();
        const done = Boolean(li.querySelector(sel.unitDone));
        const dur = (li.innerText.match(/\d{2}:\d{2}:\d{2}/) || [''])[0];
        // 稳定 key：编号 + 标题，不用下标
        return { key: (num ? num + '|' : '') + title, index, title, duration: dur, platformDone: done };
      });
    }, SELECTORS);
  },

  async openUnit(page, index) {
    const li = page.locator(SELECTORS.unitItem).nth(index);
    await li.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    const box = await li.boundingBox().catch(() => null);
    if (box) {
      // 人类化：多步移动 + 停顿
      await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2, { steps: 4 });
      await page.waitForTimeout(180);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
      await page.waitForTimeout(120);
      await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
    } else {
      await li.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(2500);
  },

  async getUnitTitle(page) {
    return await page.evaluate(() => {
      const el = document.querySelector('li.video.current_play .catalogue_title')
        || document.querySelector('.current_play .catalogue_title');
      return (el?.innerText || '').replace(/\s+/g, ' ').trim();
    }).catch(() => '');
  },

  async playUnit(page, opts = {}) {
    const speed = opts.speed || 1.5;
    return await page.evaluate((sp) => {
      const v = document.querySelector('video');
      if (!v) return { playing: false, ended: false, currentTime: 0, duration: 0 };
      v.playbackRate = sp;
      if (v.paused) v.play().catch(() => {});
      return { playing: !v.paused, ended: v.ended, currentTime: v.currentTime, duration: v.duration || 0 };
    }, speed).catch(() => ({ playing: false, ended: false, currentTime: 0, duration: 0 }));
  },

  async isPlatformDone(page, index) {
    const li = page.locator(SELECTORS.unitItem).nth(index);
    return await li.locator(SELECTORS.unitDone).count().then((n) => n > 0).catch(() => false);
  },

  async detectOverlay(page) {
    return await page.evaluate(() => {
      // 弹题
      const quiz = [...document.querySelectorAll('.el-dialog__wrapper')]
        .find((w) => /【(判断题|单选题|多选题)】/.test(w.innerText || '') && w.offsetParent !== null);
      if (quiz) return { type: 'quiz' };
      // 验证码
      const cap = document.querySelector('#tcaptcha_iframe_dy, .yidun_cover-frame');
      if (cap && cap.offsetParent !== null) return { type: 'captcha' };
      // 消息框
      const dlg = [...document.querySelectorAll('.el-message-box__wrapper')]
        .find((w) => w.offsetParent !== null);
      if (dlg) return { type: 'dialog' };
      return { type: null };
    }).catch(() => ({ type: null }));
  },

  // ============ 答题 ============
  async listTests(page) {
    return await page.evaluate(() => {
      return [...document.querySelectorAll('.examItemWrap, .course')].map((card, i) => {
        const title = (card.querySelector('.examTit, .course_ewname')?.innerText || '').trim();
        const btn = card.querySelector('a.jobExamComBtn, a.commonBtn_green, a.recreation, .showFromBtn');
        const scoreText = (card.innerText.match(/作业\s*(\d+)/) || [])[1];
        return { key: title, title, index: i, submitted: /重做|查看/.test(btn?.innerText || ''), score: scoreText ? Number(scoreText) : null };
      }).filter((x) => x.title);
    }).catch(() => []);
  },

  async openTest(page, key) {
    // 从列表点「开始答题」/「申请重做」，JS click 可能被拦截，需要有鼠标兜底
    const card = page.locator('.examItemWrap, .course').filter({ hasText: key }).first();
    const btn = card.locator('a.jobExamComBtn, a.commonBtn_green, a.recreation, .showFromBtn').first();
    if (!(await btn.count().catch(() => 0))) return { ok: false, error: 'button-not-found' };
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    const before = new Set(page.context().pages());
    await btn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(4000);
    let opened = page.context().pages().filter((p) => !before.has(p) && !p.isClosed());
    if (!opened.length) {
      await btn.evaluate((n) => n.click()).catch(() => {});
      await page.waitForTimeout(4500);
      opened = page.context().pages().filter((p) => !before.has(p) && !p.isClosed());
    }
    const target = opened.pop();
    return target ? { ok: true, page: target } : { ok: false, error: 'no-tab' };
  },

  // 必须完整：数字段会跨章节串题
  async getExamId(page) {
    const m = String(page.url()).match(/dohomework\/([^#?]+)/);
    return m ? m[1].replace(/\/0$/, '') : '';
  },

  async getQuestionCount(page) {
    // 题头「总题数: N」优先，答题卡长度兜底
    const n = await page.evaluate(() => {
      const t = document.querySelector('.examPaper_partTit')?.innerText || '';
      const m = t.match(/总题数[:：]\s*(\d+)/);
      if (m) return Number(m[1]);
      return document.querySelectorAll('.answerCard_list li').length;
    }).catch(() => 0);
    return n || 0;
  },

  async gotoQuestion(page, i) {
    const li = page.locator(SELECTORS.answerCard).nth(i);
    if (!(await li.count().catch(() => 0))) return false;
    const visible = () => page.evaluate(() =>
      [...document.querySelectorAll('.examPaper_subject')].findIndex((x) => x.offsetParent !== null)
    ).catch(() => -1);
    for (let k = 0; k < 4; k++) {
      if ((await visible()) === i) return true;
      await li.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(150);
      await li.click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
      if ((await visible()) === i) return true;
    }
    return false;
  },

  async readQuestion(page) {
    return await page.evaluate((sel) => {
      const blocks = [...document.querySelectorAll(sel.questionBlock)];
      const b = blocks.find((x) => x.offsetParent !== null);
      if (!b) return null;
      const desc = b.querySelector(sel.questionStem);
      const stem = (desc ? desc.innerText : '').replace(/\s+/g, ' ').trim();
      const typeText = (b.querySelector(sel.questionType)?.innerText || '');
      const type = /多选/.test(typeText) ? 'checkbox' : 'radio';
      const rows = [...b.querySelectorAll(sel.optionRow)];
      const options = rows.map((n) => (n.querySelector(sel.optionText)?.innerText || n.innerText || '')
        .replace(/^\s*[A-E][.、]\s*/, '').replace(/\s+/g, ' ').trim());
      const checked = rows.map((n) => {
        const img = n.querySelector(sel.optionIcon);
        const src = img ? (img.getAttribute('src') || '') : '';
        const input = n.querySelector('input');
        return src.includes('134c9fe76fac4b76ace068fdc8b95f07')
          || (input ? input.checked : false)
          || /onChecked/.test(n.querySelector(sel.optionText)?.className || '');
      });
      return { stem, options, type, checked };
    }, SELECTORS).catch(() => null);
  },

  async selectOption(page, i) {
    const visibleIdx = await page.evaluate(() =>
      [...document.querySelectorAll('.examPaper_subject')].findIndex((x) => x.offsetParent !== null)
    ).catch(() => -1);
    if (visibleIdx < 0) return false;
    const row = page.locator(SELECTORS.questionBlock).nth(visibleIdx).locator(SELECTORS.optionRow).nth(i);
    if (!(await row.count().catch(() => 0))) return false;
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(180);
    // 一级：人类化点击整行
    const box = await row.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 3 });
      await page.waitForTimeout(100);
      await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up();
    } else {
      await row.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(380);
    return true;
  },

  async readChecked(page) {
    const q = await this.readQuestion(page);
    return q ? q.checked : [];
  },

  async submit(page) {
    const btn = page.getByText('提交作业', { exact: true }).first();
    if (!(await btn.count().catch(() => 0))) return { ok: false, error: 'submit-btn-not-found' };
    await btn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(900);
    const ok = page.getByText('确定', { exact: true }).first();
    if (await ok.count().catch(() => 0)) await ok.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);
    return { ok: true };
  },

  async openReview(page, key) {
    // 从「已提交」列表点标题进解析页；不要直接跳 checkHomework（会空白）
    const card = page.locator('.examItemWrap, .course').filter({ hasText: key }).first();
    const title = card.locator('.course_ewname, .examTit').first();
    if (await title.count().catch(() => 0)) { await title.click({ force: true }).catch(() => {}); await page.waitForTimeout(4000); }
    return { ok: /checkHomework/.test(page.url()) };
  },

  async readReview(page) {
    return await page.evaluate(() => {
      const CORRECT = /e068fdc8b95f07|2099a548602d4d/;   // 解析页「正确项」标记
      return [...document.querySelectorAll('.examPaper_subject')].map((b, i) => {
        const body = b.innerText || '';
        const result = /错误/.test(body) ? 'wrong' : (/正确/.test(body) ? 'right' : '');
        const options = [...b.querySelectorAll('.nodeLab')].map((n) => {
          const img = n.querySelector('img');
          const src = img ? (img.getAttribute('src') || '') : '';
          const text = (n.querySelector('.node_detail')?.innerText || n.innerText || '')
            .replace(/^\s*[A-E][.、]\s*/, '').replace(/\s+/g, ' ').trim();
          return { text, marked: CORRECT.test(src) };
        });
        return { i, result, options, correct: options.filter((o) => o.marked).map((o) => o.text) };
      });
    }).catch(() => []);
  },
};
