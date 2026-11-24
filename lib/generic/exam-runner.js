'use strict';
/**
 * 通用答题引擎（站点无关）
 *
 * 用法：
 *   const { ExamRunner } = require('./lib/generic/exam-runner');
 *   const runner = new ExamRunner({ adapter, page, bank, log, humanClick, sleep });
 *   await runner.gotoQuestion(0);
 *   const plan = await runner.dryRun();          // 只读，不点不提交
 *   const res  = await runner.solve({ commit: true });  // 点 + 复核 + 提交
 *
 * 依赖 adapter 契约（见 docs/SPEC.md 第 2 节），不依赖具体站点。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ExamRunner {
  constructor({ adapter, page, bank, log, humanClick, speed = 1.5 }) {
    if (!adapter) throw new Error('adapter required');
    this.a = adapter;
    this.page = page;
    this.bank = bank || { chapter: {}, popup: {} };
    this.log = typeof log === 'function' ? log : () => {};
    this.humanClick = humanClick || null;
    this.speed = speed;
    this.plan = [];        // [{ i, want:[文本], indexes:[下标] }]
    this.missing = [];     // [{ i, question, options, reason }]
  }

  // ---------- 题库 ----------
  lookup(examId, index, options) {
    const key = examId + '#' + index;
    const entry = this.bank.chapter?.[key];
    if (!entry) return null;
    const answers = entry.answers || [];
    const indexes = [];
    for (const a of answers) {
      const j = options.findIndex((o) => String(o) === String(a));   // 逐字比对
      if (j >= 0) indexes.push(j);
    }
    if (indexes.length !== answers.length) {
      this.log('bank_text_mismatch', { key, want: answers, got: options });
      return null;
    }
    return { indexes, answers, source: entry.source || 'bank' };
  }

  // ---------- 单题作答 ----------
  async answerOne(i, { dry = false } = {}) {
    const okNav = await this.a.gotoQuestion(this.page, i);
    if (!okNav) { this.missing.push({ i, reason: 'nav-failed' }); return false; }

    const q = await this.a.readQuestion(this.page);
    if (!q || !q.options.length) { this.missing.push({ i, reason: 'read-failed' }); return false; }

    const examId = await this.a.getExamId(this.page);
    const hit = this.lookup(examId, i, q.options);
    if (!hit) {
      this.missing.push({ i, question: q.stem, options: q.options, type: q.type, reason: 'no-bank-answer' });
      return false;
    }

    this.plan.push({ i, want: hit.indexes.map((x) => q.options[x]), indexes: hit.indexes });
    if (dry) return true;

    const applied = await this.applySelection(q, hit.indexes);
    if (!applied) { this.missing.push({ i, question: q.stem, options: q.options, reason: 'click-failed' }); return false; }
    return true;
  }

  // 逐项对比：该选未选→点，不该选已选→点，已选且对→跳过
  async applySelection(q, wantIndexes) {
    const want = new Set(wantIndexes);
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await this.a.readQuestion(this.page);
      if (!cur) return false;
      const done = cur.checked.every((c, j) => Boolean(c) === want.has(j));
      if (done) return true;
      for (let j = 0; j < cur.checked.length; j++) {
        if (Boolean(cur.checked[j]) === want.has(j)) continue;
        await this.a.selectOption(this.page, j);
        await sleep(380);
      }
    }
    const final = await this.a.readQuestion(this.page);
    return Boolean(final) && final.checked.every((c, j) => Boolean(c) === want.has(j));
  }

  // ---------- 全卷 ----------
  async dryRun() {
    this.plan = []; this.missing = [];
    const n = await this.a.getQuestionCount(this.page);
    if (!n) throw new Error('question count = 0');
    for (let i = 0; i < n; i++) await this.answerOne(i, { dry: true });
    this.log('dry_run', { questions: n, hit: this.plan.length, missing: this.missing.length });
    return { questions: n, hit: this.plan.length, plan: this.plan, missing: this.missing };
  }

  async solve({ commit = true } = {}) {
    this.plan = []; this.missing = [];
    const n = await this.a.getQuestionCount(this.page);
    if (!n) throw new Error('question count = 0');
    for (let i = 0; i < n; i++) await this.answerOne(i, { dry: false });

    if (this.missing.length) {
      this.log('blocked_missing', { count: this.missing.length });
      return { questions: n, ok: false, reason: 'missing', missing: this.missing };
    }
    if (this.plan.length !== n) {
      this.log('blocked_incomplete', { plan: this.plan.length, questions: n });
      return { questions: n, ok: false, reason: 'incomplete', plan: this.plan.length };
    }
    if (!commit) return { questions: n, ok: true, plan: this.plan, committed: false };

    const bad = await this.precheck();
    if (bad.length) { this.log('precheck_failed', { bad }); return { questions: n, ok: false, reason: 'precheck', bad }; }

    await this.a.submit(this.page);
    this.log('submitted', { questions: n });
    return { questions: n, ok: true, committed: true };
  }

  // 提交前逐题复核：翻页 + 读选中态 + 逐字比对
  async precheck() {
    const bad = [];
    for (const p of this.plan) {
      const okNav = await this.a.gotoQuestion(this.page, p.i);
      if (!okNav) { bad.push({ i: p.i, reason: 'nav-failed' }); continue; }
      const q = await this.a.readQuestion(this.page);
      if (!q) { bad.push({ i: p.i, reason: 'read-failed' }); continue; }
      const got = q.options.filter((_, j) => q.checked[j]);
      const wantSet = [...p.want].sort();
      const gotSet = [...got].sort();
      const same = wantSet.length === gotSet.length && wantSet.every((v, k) => v === gotSet[k]);
      if (!same) bad.push({ i: p.i, want: wantSet, got: gotSet });
    }
    if (!bad.length) this.log('precheck_ok', { count: this.plan.length });
    return bad;
  }

  // ---------- 解析页回写题库 ----------
  async harvestReview() {
    const rows = await this.a.readReview(this.page);
    const examId = await this.a.getExamId(this.page);
    let written = 0;
    for (const r of rows) {
      if (r.result === 'right') continue;            // 只处理错题
      if (!r.correct?.length) continue;
      const key = examId + '#' + r.i;
      this.bank.chapter[key] = {
        ...(this.bank.chapter[key] || {}),
        examId, examIndex: r.i,
        answers: r.correct,
        source: 'review',
        updatedAt: new Date().toISOString(),
      };
      written++;
    }
    this.log('harvest_review', { rows: rows.length, written });
    return { rows: rows.length, written };
  }
}

module.exports = { ExamRunner };
