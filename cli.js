#!/usr/bin/env node
'use strict';
/**
 * 智慧树刷课/刷题 CLI
 *
 *   node cli.js status                    查看状态
 *   node cli.js exam-list                 打开考试列表
 *   node cli.js exam-run 第五章单元测试     试跑 + 提交（含复核）
 *   node cli.js exam-dry 第五章单元测试     只试跑，不提交
 *   node cli.js exam-dump 第五章单元测试    只扒题（逐题截图文本）
 *   node cli.js bank-verify <examId>      校验题库
 *   node cli.js bank-show <examId>        查看题库
 *   node cli.js summary                   成绩汇总
 *   node cli.js pages                     标签页列表
 */
const path = require('path');
const fs = require('fs');
const { ZhihuishuBot, summary } = require('./lib/bot');

const ROOT = __dirname;
const CONFIG = path.join(ROOT, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8')); } catch { return { completed: [], forcePending: [] }; }
}

async function makeBot() {
  const bot = new ZhihuishuBot({
    rootDir: ROOT,
    config: loadConfig(),
    state: loadState(),
    onEvent: (e) => { if (e && e.event) console.log('  [' + e.event + ']', e.msg || e.reason || ''); }
  });
  await bot.launch();
  if (!bot.loggedIn) {
    console.error('未登录：请先在打开的浏览器里登录智慧树，然后重跑。');
    process.exit(2);
  }
  return bot;
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!/, ''));
    return;
  }
  if (cmd === 'summary') {
    console.log(JSON.stringify(summary(ROOT), null, 2));
    return;
  }
  const bot = await makeBot();
  try {
    if (cmd === 'status') {
      const s = bot.getStatus();
      console.log(JSON.stringify({ status: s.status, done: s.done, total: s.total, timer: s.timer, loggedIn: s.loggedIn }, null, 2));
    } else if (cmd === 'pages') {
      console.log(JSON.stringify(await bot.pages(), null, 2));
    } else if (cmd === 'exam-list') {
      console.log(JSON.stringify(await bot.openExamList(), null, 2));
    } else if (cmd === 'bank-verify') {
      console.log(JSON.stringify(await bot.bankVerify(args[0]), null, 2));
    } else if (cmd === 'bank-show') {
      console.log(JSON.stringify(await bot.bankShow(args[0]), null, 2));
    } else if (cmd === 'exam-dump') {
      const r = await bot.openChapter(args[0]);
      if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); }
      console.log(JSON.stringify(await bot.dumpAll(), null, 2));
    } else if (cmd === 'exam-dry' || cmd === 'exam-run') {
      const r = await bot.openChapter(args[0]);
      if (!r.ok) { console.error('打开失败', JSON.stringify(r)); process.exit(1); }
      const dry = await bot.dryRun();
      console.log('试跑:', JSON.stringify({ questions: dry.questions, missing: (dry.missing || []).length }, null, 2));
      if ((dry.missing || []).length) { console.error('存在缺题，停止。', JSON.stringify(dry.missing, null, 2)); process.exit(3); }
      if (cmd === 'exam-dry') { console.log(JSON.stringify(dry.report, null, 2)); return; }
      const done = await bot.solve();
      console.log('提交:', JSON.stringify(done, null, 2));
    } else {
      console.error('未知命令:', cmd);
      process.exit(1);
    }
  } finally {
    await bot.close().catch(() => {});
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
