#!/usr/bin/env node
'use strict';
/**
 * 适配器自检
 *   node tools/adapter-check.js adapters/<site>.js
 *
 * 检查：
 *   1. 15 个契约方法是否全部实现（不是模板里的 throw）
 *   2. selectors 是否有空值
 *   3. selectedMarker / unselectedMarker 是否配置
 *   4. 元信息是否填写
 */
const path = require('path');

const REQUIRED = [
  'launch', 'isLoggedIn', 'gotoStudy',
  'listUnits', 'openUnit', 'getUnitTitle', 'playUnit', 'isPlatformDone', 'detectOverlay',
  'listTests', 'openTest', 'getExamId', 'getQuestionCount', 'gotoQuestion',
  'readQuestion', 'selectOption', 'readChecked', 'submit', 'openReview', 'readReview',
];
const REQUIRED_SELECTORS = [
  'unitItem', 'unitTitle', 'questionBlock', 'optionRow', 'optionText', 'answerCard', 'partTitle',
];

function main() {
  const target = process.argv[2];
  if (!target) { console.error('用法: node tools/adapter-check.js adapters/<site>.js'); process.exit(1); }
  const abs = path.resolve(process.cwd(), target);
  let adapter;
  try { adapter = require(abs); } catch (e) { console.error('加载失败:', e.message); process.exit(1); }

  const errors = [];
  const warns = [];

  // 元信息
  for (const k of ['name', 'displayName', 'origin']) {
    if (!adapter[k] || /CHANGE_ME/.test(adapter[k])) errors.push('元信息未填写: ' + k);
  }

  // 方法
  for (const m of REQUIRED) {
    if (typeof adapter[m] !== 'function') { errors.push('缺少方法: ' + m); continue; }
    const src = adapter[m].toString();
    if (/TODO:\s*'?\s*\+?\s*'?\s*month/i.test(src) || /throw new Error\('TODO/.test(src)) errors.push('方法未实现: ' + m);
    if (adapter[m].length === 0 && !['getUnitTitle', 'readChecked', 'submit'].includes(m)) {
      warns.push('方法参数为 0，确认是否合理: ' + m);
    }
  }

  // 选择器
  const sel = adapter.selectors || {};
  for (const s of REQUIRED_SELECTORS) if (!sel[s]) errors.push('选择器为空: selectors.' + s);

  // 选中态
  if (!adapter.selectedMarker) warns.push('selectedMarker 未配置，将回退到 input/类名判定（可能读到永远 false）');
  if (!adapter.unselectedMarker) warns.push('unselectedMarker 未配置');

  console.log('=== 适配器自检: ' + (adapter.name || '(未命名)') + ' ===');
  console.log('方法: ' + REQUIRED.filter((m) => typeof adapter[m] === 'function').length + '/' + REQUIRED.length);
  console.log('选择器: ' + REQUIRED_SELECTORS.filter((s) => sel[s]).length + '/' + REQUIRED_SELECTORS.length);
  if (errors.length) { console.log('\n错误:'); errors.forEach((e) => console.log('  ✗ ' + e)); }
  if (warns.length) { console.log('\n警告:'); warns.forEach((w) => console.log('  ! ' + w)); }
  if (!errors.length && !warns.length) console.log('\n全部通过。下一步按 docs/SPEC.md 15.2 节顺序验证。');
  process.exit(errors.length ? 1 : 0);
}
main();
