# 移植指南

把本工具移植到另一个刷题/刷课站点的完整流程。

---

## 0. 先判断能不能移植

| 检查项 | 满足才能继续 |
|---|---|
| 页面用普通 HTML/DOM 渲染 | 是（纯 Canvas 或重度加密就难） |
| 题目/选项能从 DOM 或截图读到 | 是 |
| 有 DOM 可探（能跑 `document.querySelector`） | 是 |
| 登录能持久化（cookie/localStorage） | 是 |
| 有可读的完成标记或进度百分比 | 是 |

---

## 1. 只写一个文件

```text
adapters/<site>.js      ← 你唯一需要新建的文件
```

复制模板：

```bash
cp adapters/_template.js adapters/newsite.js
```

---

## 2. 填选择器（占工作量 60%）

打开目标站点，F12，按下面顺序找：

### 2.1 单元列表

```text
1. 找到视频/章节列表项 → unitItem
2. 项内的标题元素 → unitTitle
3. 完成标记（对勾图标 / 100% / "已完成"）→ unitDone
4. 编号元素（可选）→ 拼进 key
```

验证：

```js
// 在 Console 里跑
[...document.querySelectorAll('你的 unitItem')].slice(0,3).map(li => ({
  title: li.querySelector('你的 unitTitle')?.innerText.trim(),
  done: !!li.querySelector('你的 unitDone'),
}))
```

### 2.2 题目区

```text
1. 单题容器 → questionBlock
2. 题干 → questionStem
3. 题型文字（要能判多选）→ questionType
4. 选项行 → optionRow
5. 选项文字 → optionText
6. 选中态图标 → optionIcon
```

### 2.3 选中态怎么找（最关键）

在 Console 里勾一个选项，再取消，对比 DOM 差异：

```js
// 勾选前后各跑一次，看哪个属性变了
const row = document.querySelector('你的 optionRow');
console.log(row.outerHTML.slice(0, 500));
```

三种常见形态：

| 形态 | 判定方式 | 示例 |
|---|---|---|
| 图标换 src | `img.src.includes('特征串')` | 智慧树 |
| 加类名 | `className.includes('checked')` | 多数站点 |
| 原生 input | `input.checked` | 简单站点 |

**把特征串填进 `selectedMarker` / `unselectedMarker`。**

### 2.4 题号来源（第二关键）

```js
// 看 DOM 里到底有几个题目块
document.querySelectorAll('你的 questionBlock').length   // N
// 再看可见的有几个
[...document.querySelectorAll('你的 questionBlock')].filter(x => x.offsetParent).length  // 通常 1
```

**如果是 N 个块但只有 1 个可见**，那么题号**必须**用答题卡：

```js
document.querySelectorAll('你的 answerCard').length   // 应该是真实题数
```

找不到答题卡时，退而用题头：

```js
document.querySelector('你的 partTitle')?.innerText   // "第1部分 总题数: 10"
```

---

## 3. 实现 20 个方法（占工作量 30%）

按顺序做，每步验证通过再做下一步。

### 3.1 基础

```js
async launch(ctx)       // 返回 Playwright context
async isLoggedIn(page)  // 在 Console 看哪个字符串只出现在登录后
async gotoStudy(page)
```

验证：

```bash
node tools/adapter-check.js adapters/newsite.js
```

### 3.2 单元

```js
async listUnits(page)          // 必须有稳定 key
async openUnit(page, index)    // 打开后标题要对
async getUnitTitle(page)
async playUnit(page, opts)     // 设 playbackRate + play()
async isPlatformDone(page, i)
async detectOverlay(page)      // 弹题/验证码/弹框
```

验证：

```js
const units = await adapter.listUnits(page);
console.log(units.slice(0, 3));
// 每项应有 { key, index, title, platformDone }
// key 里不能只有下标
```

### 3.3 答题

```js
async listTests(page)
async openTest(page, key)
async getExamId(page)          // 完整唯一！不能只取数字
async getQuestionCount(page)
async gotoQuestion(page, i)    // 必须验证切换真的生效
async readQuestion(page)
async selectOption(page, i)
async readChecked(page)
async submit(page)
```

**`gotoQuestion` 的正确写法**：

```js
async gotoQuestion(page, i) {
  const li = page.locator(SELECTORS.answerCard).nth(i);
  if (!(await li.count())) return false;
  const visible = () => page.evaluate(() =>
    [...document.querySelectorAll(SELECTORS.questionBlock)]
      .findIndex(x => x.offsetParent !== null)
  );
  for (let k = 0; k < 4; k++) {
    if ((await visible()) === i) return true;    // 已经对了
    await li.click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);
  }
  return false;                                   // 4 次都没切过去
}
```

**`getExamId` 的正确写法**：

```js
async getExamId(page) {
  const m = String(page.url()).match(/dohomework\/([^#?]+)/);
  return m ? m[1].replace(/\/0$/, '') : '';
  // 返回 "<examId>"，不是 "<id>"
}
```

---

## 4. 验证顺序（严格按此执行）

```text
① 列表页 → 看到全部单元/测试
② 打开一个单元 → 标题正确 + 能播放
③ 打开一个测试 → 题数正确
④ gotoQuestion 逐题翻 → 每题 stem/options 都对
⑤ 手动勾选 → readChecked 能读到 true
⑥ 扒全部题目 → 每题内容不重复
⑦ 写题库 → bank_verify 100% 通过
⑧ dryRun → 每题 picked 都对
⑨ solve → precheck_ok → 提交 → 成绩符合预期
```

### ④ 的验证脚本

```js
for (let i = 0; i < n; i++) {
  const ok = await adapter.gotoQuestion(page, i);
  const q = await adapter.readQuestion(page);
  console.log(i, ok, q?.stem?.slice(0, 30), q?.options);
  // 相邻两题的 options 不能完全一样！一样就说明没切过去
}
```

### ⑤ 的验证脚本

```js
// 手动在页面上勾一个选项，然后：
console.log(await adapter.readChecked(page));   // 应含至少一个 true
```

---

## 5. 判题来源（占工作量 10%）

### 5.1 优先搜原卷

```text
搜索词模板：
  "<课程名> <章节> 单元测试 答案"
  "<课程名> 智慧树 <章节>测试 答案 <学校名>"
  ""题干原文片段" 正确答案"
```

实测有效：搜到学校 + 课程 + 章节的 PDF/docx 答案文档，命中率最高。

### 5.2 找不到用隔离子智能体

**必须开新对话**，不能让主对话的错题污染判断。提示词见 SPEC.md 7.1。

### 5.3 结果必须核对

子智能体判断**不等于**正确。实测错例：

| 题 | 子智能体 | 正确 |
|---|---|---|
| 不属于大学生情绪特点 | 丰富性和狭隘性 | 成熟性和幼稚性 |
| 紧张焦虑会降低学习效率 | 对 | 错 |

规则：**medium / low 置信度一律复核。**

---

## 6. 写题库

```js
// 选项文本必须与平台逐字一致
bank.chapter[examId + '#' + index] = {
  examId, examIndex: index, examTitle: '第N章单元测试',
  type: 'radio' | 'checkbox',
  question: '题干原文',
  options: ['选项1', '选项2'],      // ← 从 readQuestion 直接复制，不要手打
  answers: ['正确选项原文'],
  indexes: [0],                     // optional，运行时按内容重算
  source: 'web-verified' | 'subagent' | 'manual',
  verified: false,
};
```

**铁律：options 必须从 `readQuestion` 的输出复制，不要手敲。**
手敲会引入全角/半角、`º`/`°`、`－`/`—` 差异，导致匹配失败。

---

## 7. 常见移植阻塞

| 阻塞 | 判断 | 对策 |
|---|---|---|
| 题干完全读不到 | `questionStem.innerText` 为空 | 只能截图 + 视觉识别，或放弃该站点 |
| 选项顺序每次都变且无稳定标识 | 无解题思路 | 按内容匹配（本框架已支持） |
| 提交需要短信/人脸 | 无法自动 | 人工节点，框架只做到"提交前" |
| 验证码是行为分析型 | 拖拽也过不了 | 人工介入 |
| 站点有 anti-bot（无头检测） | `navigator.webdriver` 被查 | 用持久化 profile + 非无头 |

---

## 8. 移植后回归

```bash
node tools/adapter-check.js adapters/newsite.js   # 契约自检
node tests/engine.test.js                          # 引擎算法
node tests/bank_mapping.test.js                    # 题库映射
node tests/timer_once.test.js                      # 计时逻辑
node tests/autonomy_offline.test.js                # 离线自主
node cli.js exam-dry <章节>                        # 真机试跑
```

全部通过才算移植完成。
