'use strict';
/**
 * 通用引擎离线测试：用假 adapter 验证核心算法
 * 不需要浏览器、不需要网络、不需要题库文件
 *
 *   node tests/engine.test.js
 */
const assert = require('assert');
const path = require('path');
const { ExamRunner } = require(path.join(__dirname, '..', 'lib', 'generic', 'exam-runner'));

// ---- 假题目：8 题，含单选/多选/判断 ----
const QUESTIONS = [
  { stem: 'Q1 单选', options: ['甲', '乙', '丙'], type: 'radio', answer: ['乙'] },
  { stem: 'Q2 判断', options: ['对', '错'], type: 'radio', answer: ['错'] },
  { stem: 'Q3 多选', options: ['A项', 'B项', 'C项', 'D项'], type: 'checkbox', answer: ['A项', 'C项'] },
  { stem: 'Q4 单选', options: ['x', 'y', 'z'], type: 'radio', answer: ['z'] },
  { stem: 'Q5 判断', options: ['对', '错'], type: 'radio', answer: ['对'] },
  { stem: 'Q6 多选', options: ['一', '二', '三'], type: 'checkbox', answer: ['一', '二', '三'] },
  { stem: 'Q7 单选', options: ['p', 'q'], type: 'radio', answer: ['p'] },
  { stem: 'Q8 判断', options: ['对', '错'], type: 'radio', answer: ['错'] },
];

// 每次取题都把选项顺序打乱，模拟真实随机
function shuffled(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeAdapter(questionOrder) {
  // pickedByContent[i] = Set(被选中的选项内容)，与顺序无关，模拟真实页面按内容保留选择
  const state = {
    cur: 0,
    order: questionOrder,
    pickedByContent: QUESTIONS.map(() => new Set()),
    submitted: false,
    visit: 0,
  };
  return {
    name: 'fake', displayName: 'fake', origin: 'http://fake', selectors: {},
    selectedMarker: 'SEL', unselectedMarker: 'UNSEL',

    async getExamId() { return 'FAKE/EXAM/1'; },
    async getQuestionCount() { return QUESTIONS.length; },

    async gotoQuestion(page, i) {
      state.cur = i;
      // 模拟：每次进入题目，选项都重新随机排序
      const q = QUESTIONS[i];
      state.order = shuffled(q.options, 1000 + i * 7 + (state.visit = state.visit + 1));
      return true;
    },

    async readQuestion() {
      const q = QUESTIONS[state.cur];
      const picked = state.pickedByContent[state.cur];
      return {
        stem: q.stem,
        options: [...state.order],
        type: q.type,
        checked: state.order.map((o) => picked.has(o)),
      };
    },

    async selectOption(page, j) {
      const q = QUESTIONS[state.cur];
      const set = state.pickedByContent[state.cur];
      const content = state.order[j];
      if (q.type === 'radio') { set.clear(); set.add(content); }
      else { if (set.has(content)) set.delete(content); else set.add(content); }
    },

    async readChecked() { return (await this.readQuestion()).checked; },

    async submit() { state.submitted = true; return { ok: true }; },

    state,
  };
}

function buildBank() {
  const bank = { chapter: {}, popup: {} };
  QUESTIONS.forEach((q, i) => {
    bank.chapter['FAKE/EXAM/1#' + i] = {
      examId: 'FAKE/EXAM/1', examIndex: i, type: q.type,
      question: q.stem, options: [...q.options], answers: [...q.answer],
      source: 'test',
    };
  });
  return bank;
}

(async () => {
  const results = [];

  // ---- 测试 1：dryRun 不点不提交 ----
  {
    const ad = makeAdapter();
    const runner = new ExamRunner({ adapter: ad, page: {}, bank: buildBank(), log: () => {} });
    const r = await runner.dryRun();
    assert.strictEqual(r.questions, 8, 'dryRun 题数');
    assert.strictEqual(r.hit, 8, 'dryRun 全部命中');
    assert.strictEqual(r.missing.length, 0, 'dryRun 无缺题');
    assert.strictEqual(ad.state.submitted, false, 'dryRun 不应提交');
    assert.ok(ad.state.pickedByContent.every((s) => s.size === 0), 'dryRun 不应点选');
    results.push('dryRun: 8题全命中，未点选未提交');
  }

  // ---- 测试 2：solve 正常路径 ----
  {
    const ad = makeAdapter();
    const runner = new ExamRunner({ adapter: ad, page: {}, bank: buildBank(), log: () => {} });
    const r = await runner.solve({ commit: true });
    assert.strictEqual(r.ok, true, 'solve 应成功');
    assert.strictEqual(ad.state.submitted, true, '应提交');
    // 验证每题勾选内容与答案一致
    for (let i = 0; i < QUESTIONS.length; i++) {
      const gotContents = [...ad.state.pickedByContent[i]].sort();
      const wantContents = [...QUESTIONS[i].answer].sort();
      assert.deepStrictEqual(gotContents, wantContents, 'Q' + (i + 1) + ' 选中内容应正确');
    }
    results.push('solve: 8题全对，选项乱序不影响');
  }

  // ---- 测试 3：缺题必须阻塞提交 ----
  {
    const bank = buildBank();
    delete bank.chapter['FAKE/EXAM/1#3'];
    const ad = makeAdapter();
    const runner = new ExamRunner({ adapter: ad, page: {}, bank, log: () => {} });
    const r = await runner.solve({ commit: true });
    assert.strictEqual(r.ok, false, '缺题必须失败');
    assert.strictEqual(r.reason, 'missing', '失败原因是缺题');
    assert.strictEqual(r.missing[0].i, 3, '缺的是第 4 题');
    assert.strictEqual(ad.state.submitted, false, '缺题不得提交');
    results.push('缺题: 正确阻塞，未提交');
  }

  // ---- 测试 4：precheck 捕获人为篡改 ----
  {
    const ad = makeAdapter();
    const runner = new ExamRunner({ adapter: ad, page: {}, bank: buildBank(), log: () => {} });
    // 先正常作答，再在提交前把第 0 题改错
    const origGoto = ad.gotoQuestion.bind(ad);
    let visits0 = 0;
    ad.gotoQuestion = async (page, i) => {
      const ok = await origGoto(page, i);
      if (i === 0) {
        visits0++;
        // 第 2 次访问第 1 题 = 复核阶段，此时篡改成错误选项，模拟页面保留了旧答案
        if (visits0 === 2) {
          const wrong = ad.state.order.find((o) => !QUESTIONS[0].answer.includes(o));
          ad.state.pickedByContent[0] = new Set([wrong]);
        }
      }
      return ok;
    };
    const r = await runner.solve({ commit: true });
    assert.strictEqual(r.ok, false, '被篡改必须失败');
    assert.strictEqual(r.reason, 'precheck', '失败原因是复核');
    assert.strictEqual(r.bad[0].i, 0, '问题在第 1 题');
    assert.strictEqual(ad.state.submitted, false, '复核失败不得提交');
    results.push('precheck: 篡改被拦，未提交');
  }

  // ---- 测试 5：文本差异不得误命 ----
  {
    const bank = buildBank();
    bank.chapter['FAKE/EXAM/1#3'].answers = ['z°'];   // 题库写成度符号
    // 平台实际是 360º（序数符号）差异场景 → 用 Q4 的 z 模拟
    const ad = makeAdapter();
    const runner = new ExamRunner({ adapter: ad, page: {}, bank, log: () => {} });
    const r = await runner.solve({ commit: true });
    assert.strictEqual(r.ok, false, '文本不一致必须失败');
    assert.strictEqual(r.reason, 'missing', '视为缺题而非误命中');
    assert.strictEqual(ad.state.submitted, false, '不得提交');
    results.push('文本差异: 不误命，视为缺题');
  }

  console.log('=== 通用引擎测试 ===');
  results.forEach((r) => console.log('  ✓ ' + r));
  console.log('\n全部通过 (' + results.length + '/5)');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
