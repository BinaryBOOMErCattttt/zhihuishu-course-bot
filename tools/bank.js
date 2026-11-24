#!/usr/bin/env node
'use strict';
/**
 * 题库管理
 *
 *   node tools/bank.js list                    列出可用题库包
 *   node tools/bank.js install <name>          把 banks/<name>.json 装到运行时
 *   node tools/bank.js export <name>           把运行时题库导出为 banks/<name>.json
 *   node tools/bank.js info                    当前运行时题库统计
 *   node tools/bank.js verify [examId]         选项反转验证
 *
 * 运行时题库路径由 config.bankPath 决定，默认 data/quiz-bank.json。
 * banks/ 是「可插拔包」目录，社区贡献题库放这里。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BANKS = path.join(ROOT, 'banks');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; }
}
function runtimeBankPath() {
  const cfg = loadConfig();
  return cfg.bankPath ? path.resolve(ROOT, cfg.bankPath) : path.join(ROOT, 'data', 'quiz-bank.json');
}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }

function list() {
  if (!fs.existsSync(BANKS)) { console.log('banks/ 不存在'); return; }
  const files = fs.readdirSync(BANKS).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  if (!files.length) { console.log('banks/ 下没有题库包'); return; }
  console.log('可用题库包:\n');
  for (const f of files) {
    const b = readJson(path.join(BANKS, f), {});
    const meta = b._meta || {};
    const c = Object.keys(b.chapter || {}).length;
    const p = Object.keys(b.popup || {}).length;
    console.log('  ' + f.replace(/\.json$/, ''));
    console.log('    ' + (meta.course || meta.name || '(未命名)') + '  ·  ' + (meta.site || '?'));
    console.log('    题量: chapter ' + c + ' / popup ' + p);
  }
}

function install(name) {
  const src = path.join(BANKS, name.endsWith('.json') ? name : name + '.json');
  if (!fs.existsSync(src)) { console.error('找不到题库包:', src); process.exit(1); }
  const data = readJson(src, null);
  if (!data) { console.error('题库包格式错误'); process.exit(1); }
  const dst = runtimeBankPath();
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // 备份现有运行时题库
  if (fs.existsSync(dst)) {
    const bak = dst + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(dst, bak);
    console.log('已备份当前题库 →', path.relative(ROOT, bak));
  }
  fs.writeFileSync(dst, JSON.stringify({ chapter: data.chapter || {}, popup: data.popup || {} }, null, 2));
  console.log('已安装 →', path.relative(ROOT, dst));
  console.log('  chapter', Object.keys(data.chapter || {}).length, '/ popup', Object.keys(data.popup || {}).length);
}

function exportBank(name) {
  const data = readJson(runtimeBankPath(), null);
  if (!data) { console.error('运行时题库不存在或格式错误'); process.exit(1); }
  fs.mkdirSync(BANKS, { recursive: true });
  const out = path.join(BANKS, name.endsWith('.json') ? name : name + '.json');
  fs.writeFileSync(out, JSON.stringify({
    _meta: { name, site: 'zhihuishu', exportedAt: new Date().toISOString() },
    chapter: data.chapter || {},
    popup: data.popup || {},
  }, null, 2));
  console.log('已导出 →', path.relative(ROOT, out));
}

function info() {
  const f = runtimeBankPath();
  const data = readJson(f, null);
  if (!data) { console.log('运行时题库不存在:', path.relative(ROOT, f)); return; }
  const chapters = {};
  for (const v of Object.values(data.chapter || {})) {
    const t = v.examTitle || (v.examId || '').split('/').slice(-4).join('/');
    chapters[t] = (chapters[t] || 0) + 1;
  }
  console.log('运行时题库:', path.relative(ROOT, f));
  console.log('  chapter', Object.keys(data.chapter || {}).length, '/ popup', Object.keys(data.popup || {}).length);
  for (const [k, v] of Object.entries(chapters).sort()) console.log('    ' + k + ': ' + v + ' 题');
}

function verify(examId) {
  const { Bot } = require(path.join(ROOT, 'lib', 'bot.js'));
  const cfg = loadConfig();
  const bot = new Bot({ rootDir: ROOT, config: cfg, state: { completed: [], forcePending: [] }, onEvent: () => {} });
  const bank = bot.ensureQuizBank();
  const rows = Object.entries(bank.chapter || {}).filter(([, v]) => !examId || v.examId === examId);
  let pass = 0; const fails = [];
  for (const [, v] of rows) {
    const shuffled = [...(v.options || [])].reverse();
    const hit = bot.lookupExamAnswer(v.examId, v.examIndex, shuffled, v.type);
    const got = (hit ? hit.indexes : []).map((i) => shuffled[i]).sort().join('|');
    const want = (v.answers || []).slice().sort().join('|');
    if (got === want) pass++; else fails.push({ examId: v.examId, i: v.examIndex, got, want });
  }
  console.log('校验', rows.length, '题 → 通过', pass, '失败', fails.length);
  if (fails.length) { fails.slice(0, 5).forEach((f) => console.log('  ✗', JSON.stringify(f))); process.exit(1); }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'list') list();
else if (cmd === 'install') install(arg || '');
else if (cmd === 'export') exportBank(arg || 'custom');
else if (cmd === 'info') info();
else if (cmd === 'verify') verify(arg);
else console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!/, ''));
