# 刷题/刷课自动化 通用规范 v1.0

> 站点无关的工程规范。智慧树是参考实现，不是规范本身。
> 目标：换一个课程站点时，只写一个适配器文件 + 一份选择题库，其余全部复用。

---

## 0. 设计原则

| 原则 | 含义 |
|---|---|
| **内容优先** | 一切匹配基于「文本内容」，绝不基于 A/B/C/D 位置。选项随机是常态 |
| **可见优先** | 只操作 `offsetParent !== null` 的元素。DOM 里存在 ≠ 可点击 |
| **先验后交** | 提交前必须逐题复核选中态，不一致就拒绝提交 |
| **探针先行** | 出问题先截图 + 探 DOM，不要盲改代码 |
| **不重启** | 单页异常只处理该页，绝不重启浏览器/进程 |
| **有界重试** | 所有重试有上限，超限上报人工，绝不无限循环 |
| **可回滚** | 状态、题库、补丁都要能回退 |

---

## 1. 分层架构

```text
┌─────────────────────────────────────────┐
│ L5 控制台 UI      进度 / 计时 / 人工接管    │
├─────────────────────────────────────────┤
│ L4 运行时控制器   启动/暂停/停止/预算/调度   │
├─────────────────────────────────────────┤
│ L3 业务适配器     单元/答题/解析（站点相关） │
├─────────────────────────────────────────┤
│ L2 通用引擎       题库/匹配/点击/复核/验证码 │
├─────────────────────────────────────────┤
│ L1 浏览器抽象     标签页/页面/坐标/人类化输入 │
└─────────────────────────────────────────┘
```

**移植工作只发生在 L3。** L1/L2/L4/L5 完全复用。

---

## 2. 适配器契约（唯一需要写的文件）

```js
module.exports = {
  // ---- 元信息 ----
  name: 'zhihuishu',
  displayName: '智慧树',

  // ---- 站点常量 ----
  origin: 'https://studyvideoh5.zhihuishu.com',
  selectors: { /* 见第 3 节 */ },

  // ---- L1 浏览器 ----
  async launch(ctx) {},              // ctx: { browser, profileDir, headless }
  async isLoggedIn(page) {},         // → boolean
  async gotoStudy(page) {},          // 打开学习页

  // ---- 单元（视频/章节）----
  async listUnits(page) {},          // → [{ key, index, title, duration, platformDone }]
  async openUnit(page, index) {},    // 人类化点击 + 标题校验
  async getUnitTitle(page) {},       // → 当前单元标题（用于校验切换成功）
  async playUnit(page, opts) {},     // opts: { speed } → { playing, ended, currentTime, duration }
  async isPlatformDone(page, index) {},  // → boolean
  async detectOverlay(page) {},      // → { type: 'quiz'|'captcha'|'dialog'|null, node }

  // ---- 答题 ----
  async listTests(page) {},          // → [{ key, title, url, submitted, score }]
  async openTest(page, key) {},      // 打开答题页
  async getExamId(page) {},          // → 唯一考试标识（必须完整，不能截断）
  async getQuestionCount(page) {},   // → number，来源：题头 "总题数: N"
  async gotoQuestion(page, i) {},    // 切到第 i 题（0 基），必须确认切换成功
  async readQuestion(page) {},       // → { stem, options:[text], type, checked:[bool] }
  async selectOption(page, i) {},    // 只点第 i 个选项（第 i 个选项，第 i 个选项。下标）
  async readChecked(page) {},        // → [bool]   当前选中态
  async submit(page) {},             // 提交
  async openReview(page, key) {},    // 打开解析页
  async readReview(page) {},         // → [{ i, result:'right'|'wrong', options, correct }]
};
```

### 2.1 方法约束

| 方法 | 硬要求 |
|---|---|
| `listUnits` | 必须返回**稳定 key**（不是下标） |
| `openUnit` | 打开后**必须**调 `getUnitTitle` 校验，不匹配就重试 |
| `gotoQuestion` | **必须验证**切换真的生效（可见题块下标 === i） |
| `readQuestion` | `options` 必须是**纯选项文本**，去掉「A.」「B、」前缀 |
| `getExamId` | 必须**全局唯一**（含全部路径段），不能只用数字 ID |
| `readChecked` | 必须反映**真实**选中态（见第 5 节） |

---

## 3. 选择器外置

适配器里集中一份：

```js
selectors: {
  // 单元列表
  unitItem: 'li.video',
  unitTitle: '.catalogue_title',
  unitDone: '.time_icofinish',

  // 题目容器
  questionBlock: '.examPaper_subject',
  questionStem: '.subject_describe',
  questionType: '.subject_type',
  optionRow: '.nodeLab',
  optionText: '.node_detail',
  optionIcon: 'img',              // 选中态图标

  // 答题卡
  answerCard: '.answerCard_list li',

  // 题头统计
  partTitle: '.examPaper_partTit',  // "第1部分 总题数: 10"

  // 导航
  prevBtn: '.switch-btn-box button:nth-child(1)',
  nextBtn: '.switch-btn-box button:nth-child(2)',
  submitBtn: '提交作业',

  // 解析页
  reviewBlock: '.examPaper_subject',
  reviewResult: '.examPaper_subject',   // 内部含「正确/错误」文字
}
```

**任何选择器都不能硬编码在引擎里。**

---

## 4. 题库模型

### 4.1 结构

```json
{
  "chapter": {
    "<examId>#<index>": {
      "examId": "站点/课程/考试完整路径",
      "examIndex": 0,
      "examTitle": "第五章单元测试",
      "type": "radio | checkbox",
      "question": "题干原文",
      "options": ["选项内容1", "选项内容2"],
      "answers": ["正确选项内容"],
      "indexes": [2],
      "verified": true,
      "verifiedScore": 20,
      "source": "web-verified | subagent | manual",
      "note": "备注"
    }
  },
  "popup": {
    "<sha1>": { "question": "...", "options": [...], "answers": [...], "type": "radio" }
  }
}
```

### 4.2 键规则

| 类别 | 键 | 理由 |
|---|---|---|
| 章节题 | `examId + "#" + index` | 题干可能是图片/动态渲染，文本不可靠 |
| 弹题 | `sha1(type + "|" + 归一化题干 + "|" + 排序选项)` | 无考试上下文，只能靠内容 |

**examId 必须完整。** 反例：`<id>`（只有数字）→ 7 个章节全部串题。
正例：`<courseId>/<paperId>/<token>/1164`。

### 4.3 归一化

```js
const norm = s => String(s || '')
  .replace(/\s+/g, '')                       // 去所有空白
  .replace(/[，。！？、；：,.!?;:'"“”‘’（）()\[\]【】]/g, '')  // 去标点
  .trim();
```

**注意：归一化只用于「题干」和「选项集合哈希」，不用于「答案映射」。**
答案映射必须用**原始文本**逐字比对，因为 `360º` ≠ `360°`。

---

## 5. 选中态检测（最容易踩的坑）

优先级从高到低：

```text
1. 图标 src 特征串        img.src.includes('已选中特征hash')
2. 原生 input            input.checked
3. 类名                 /onChecked|is-checked|active/.test(className)
4. 视觉（兜底）           截图比对
```

**实测教训**：智慧树页面**从不加 `onChecked` 类**，状态全在 `img.src`：

```text
e777864488... = 未选中
134c9fe76f... = 已选中
```

如果只读类名，会得到「永远未选中」→ 反复点同一个选项 → 已选的被取消 → 提交全错。

---

## 6. 答题执行算法

```text
for i in 0..N-1:
  ┌─ 1. gotoQuestion(i)
  │     必须验证：visibleBlockIndex === i
  │     失败 → 重试（最多 6 次）→ 仍失败则记为缺题
  ├─ 2. readQuestion()  → { stem, options, type, checked }
  ├─ 3. lookup(examId, i, options, type)
  │     命中 → { indexes }
  │     未命中 → 记为缺题，**不猜**
  ├─ 4. applySelection(wantIndexes)
  │     for j in 0..len-1:
  │       need = wantIndexes.includes(j)
  │       if checked[j] === need: continue
  │       click(j)                      ← 三级兜底
  │       re-read checked
  │       if 仍未变 → 下一级兜底
  │     全部对齐才算成功
  └─ 5. 记录 plan.push({ i, want:[文本] })

提交前：
  for each i: gotoQuestion(i) → readChecked() → 与 plan[i].want 逐字比对
  有任何不一致 → **拒绝提交**，返回 precheckFailed
全部一致 → submit()
```

### 6.1 点击三级兜底

```text
1. 人类化点击整行（多步移动 + 随机停顿）
2. 点击选项圆圈坐标（boundingBox.x + 14）
3. 直接派发事件 + 点内层文本节点
```

每级点完都要回读确认。

---

## 7. 判题优先级

```text
1. 题库命中
       ↓ 未命中
2. 联网搜原卷（"课程名 + 章节 + 单元测试 + 答案"）
       ↓ 未命中
3. 隔离上下文子智能体判断
       ↓ 未命中
4. 模型视觉（截图）
       ↓ 未命中
5. 记入缺题 → 阻塞提交 → 请求人工
```

### 7.1 子智能体提示词模板

```text
你是《课程名》的答题专家。任务：独立判断 N 道题的正确选项。

参考资料优先级：课程教材 > 网络搜索 > 学科常识。

硬性要求：
- 只输出结论
- 答案必须用「选项内容原文」，不要用 A/B/C/D（选项顺序随机）
- 多选题给全部正确项，不多选不漏选
- 判断题只能选「对」或「错」
- 每题给出置信度 high/medium/low
- 不确定写 UNSURE 并给两个最可能组合

输出格式：
题号: N
答案: 内容1 || 内容2
置信度: high/medium/low
理由: 一句话
```

**为什么必须隔离上下文**：主对话里有过往错题、旧答案、争议讨论，会污染判断。实测同一模型在空白对话里判得更准。

### 7.2 判题后必须核对

子智能体判断 ≠ 正确。**medium/low 置信度必须人工或联网复核。**

实测反例：
- 「大学生情绪特点不包括」→ 子智能体答「丰富性和狭隘性」，实际是「成熟性和幼稚性」
- 「紧张焦虑会降低学习效率」→ 子智能体答「对」，实际是「错」（倒 U 型）

---

## 8. 错误自愈协议

### 8.1 触发

`level:error` / 连续失败 N 次 / 看门狗空闲超时

### 8.2 固化动作

```text
1. 截图一张 → data/incidents/incident-<ts>.png
2. 抓触发点前后各 17 条日志（共 35 条）
3. 写 incident-<ts>.json（触发事件 + 日志 + 截图路径 + 页面 URL）
4. 推给调试 Agent（带最近 2 轮记忆）
5. Agent 动作 → 每次动作后检查是否已接管
6. 未接管 → 重试；超限 → 请求人工
```

### 8.3 Agent 可用工具

```text
只读类：get_page_state / dom_probe / dump_quiz / dump_exam / review_checked
操作类：click_text / click_nth / click_xy / goto_url / page_reload / dismiss_boxes
结构性：open_chapter / open_exam_list / switch_exam / pages_tree / page_focus / page_dedupe
扩展类：write_plugin / run_plugin / patch_method
终点：  request_human
```

---

## 9. 验证码

| 类型 | 处理 |
|---|---|
| 滑块拼图 | 截图 → 视觉定位缺口 → 多段拖动（含中途停顿） |
| 字符点选 | 截图 → 识别目标字符 → `click_xy(x, y)` |
| 图形点选 | 同上 |

规则：

- 只在浮层**真正可见**时判定
- 每次重试换一张
- 有界（≤ 6 次）
- 最终退回前端人工弹窗，**绝不静默继续**

---

## 10. 标签页管理

**绝不因为单页异常重启浏览器。**

```text
pages()        → [{ id, kind, url, title, current, closed }]
focus(id)      → 切换当前页（bringToFront）
close(id)      → 关非当前页；只剩一个时拒绝
dedupe()       → 同 URL 收敛为一个（保护当前页）
reload()       → 只刷新当前页
```

`ensurePage()` 的正确实现：

```js
async ensurePage() {
  if (this.context) {
    if (this.page && !this.page.isClosed()) return this.page;
    const live = this.context.pages().filter(p => !p.isClosed());
    if (live.length) { this.page = live[0]; return this.page; }
    const np = await this.context.newPage();
    this.page = np; return np;
  }
  await this.launch();   // 只有 context 真的死了才重开
  return this.page;
}
```

---

## 11. 每日预算

```json
{ "date": "YYYY-MM-DD", "seconds": 0, "limit": 1500, "notified": false }
```

- 仅日期变化时重置
- **只在实际播放时累加**
- 到上限：停止 + 前端弹窗 + `notified = true`
- **一天只提醒一次**，之后用户可自行继续
- 计真实时间，不按倍速折算

---

## 12. 人类化输入

| 动作 | 要求 |
|---|---|
| 鼠标移动 | 多步（≥ 3），带随机位移 |
| 点击 | 移动 → 停顿 → 按下 → 短停 → 抬起 |
| 滚动 | 先 `scrollIntoViewIfNeeded`，等动画 |
| 等待 | 200–800ms 随机，不用固定值 |
| `element.click()` | **只作最后兜底**，不作主路径 |

---

## 13. 崩溃可诊断

```js
process.on('uncaughtException',  err => { record('uncaughtException', err); ... });
process.on('unhandledRejection', err => { record('unhandledRejection', err); ... });
process.on('exit', code => { if (code !== 0) record('exit', code); });
```

`record()` 写入 `data/crash.log`：`{ t, kind, msg, stack, url, status }`。

识别到 `Target closed` / `browser has disconnected` 时：

```js
bot.context = null; bot.page = null; bot.status = 'idle';
```

进程不退出，用户可重新连浏览器。

---

## 14. 持久化清单

| 文件 | 内容 | 可提交 |
|---|---|---|
| `data/state.json` | 单元完成、强制重播、目录快照 | ❌ |
| `data/timer.json` | 每日预算 | ❌ |
| `data/quiz-bank.json` | 题库 | ❌（含答案） |
| `data/exam-results.json` | 成绩 | ❌ |
| `data/agent-memory.json` | Agent 短期记忆 | ❌ |
| `data/incidents/` | 截图 + 日志 | ❌ |
| `data/plugins/` | Agent 生成脚本 | ❌ |
| `data/patches.json` | 方法覆盖 | ❌ |
| `data/crash.log` | 崩溃堆栈 | ❌ |
| `config.json` | 密钥、账号 | ❌ |

---

## 15. 移植检查清单

### 15.1 必做

- [ ] 适配器 15 个方法全部实现
- [ ] `listUnits` 返回稳定 key（非下标）
- [ ] `openUnit` 后有标题校验
- [ ] `gotoQuestion` 后验证可见块下标
- [ ] `readChecked` 用真实选中态来源
- [ ] `getExamId` 返回完整唯一标识
- [ ] 题数来源改用题头「总题数: N」或答题卡长度
- [ ] 选项文本去掉「A.」前缀
- [ ] 题库写完后跑 `bank_verify`（选项反转）
- [ ] 提交前有逐题复核

### 15.2 验证顺序

```text
1. 打开列表页 → 能看到全部单元/测试
2. 打开一个单元 → 标题正确 + 能播放
3. 打开一个测试 → 题数正确
4. gotoQuestion 逐题翻 → 每题的 stem/options 都对
5. readChecked 在手动勾选后能读到 true
6. dumpAll 扒全部题目
7. 写题库 → bank_verify 100% 通过
8. dryRun → 每题的 picked 都对
9. solve → precheck_ok → 提交 → 成绩符合预期
```

---

## 16. 踩坑总表（实测）

| # | 现象 | 根因 | 解法 |
|---|---|---|---|
| 1 | 点选项无任何反应 | 目标 block `offsetParent === null` | 只操作可见 block |
| 2 | 选中态永远 false | 页面不加 `onChecked` 类 | 读 `img.src` 特征串 |
| 3 | 题号与题目错位 | DOM 里 N 个块只有 1 个可见，`q.i` 是块下标不是题号 | 题号改用答题卡 `.answerCard_list li` |
| 4 | 7 个章节互相串题 | examId 只取数字段 `<id>` | 用完整路径作 examId |
| 5 | 答案匹配失败但文本看着一样 | 全角符号差异 `360º`/`360°`、`－`/`—` | 选项文本逐字比对，不用归一化 |
| 6 | 考试列表打开是空白 | 裸跳 `#/webExamList` 无上下文 | 必须从学习页点「作业考试」进去 |
| 7 | 解析页刷新后空白 | `reload` 丢 SPA 状态 | 从列表重新点进，不刷新 |
| 8 | 单选重做时改不过来 | 重做页预置上轮答案，点自身不能取消 | 直接点目标项，单选自动替换 |
| 9 | 题干抓出来是空 | 题干动态渲染，无文本节点 | 只能截图 + 视觉识别 |
| 10 | 8 题抓出同一组选项 | 逐题翻页失败，一直读第一个块 | `gotoQuestion` 必须验证切换 |
| 11 | 进程静默退出 | 无 `uncaughtException` 处理 | 加崩溃钩子 + crash.log |
| 12 | 页面异常后登录态丢失 | 直接重启 browser context | 只切标签页，不重启 |
| 13 | 子智能体判断题错 | 常识推理代替教材原文 | 优先联网搜原卷；medium 置信度必须复核 |
| 14 | 提交后成绩低于预期 | 未做提交前复核 | 逐题翻页比对，不一致拒绝提交 |
| 15 | 题库越写越乱有重复 | 同题多份记录（带/不带 `/0` 后缀） | 写入前统一 normalize examId |

---

## 17. 测试矩阵

| 测试 | 断言 |
|---|---|
| 题库映射 | 选项反转 ×5 轮，100% 命中 |
| 计时器 | 到上限触发一次，第二次允许继续 |
| 离线自主 | 断开模型 API，题库仍能完成全部判题 |
| 导航 | `gotoQuestion(i)` 后 `visibleBlockIndex === i` |
| 复核 | 人为改错一个选项，`solve` 必须拒绝提交 |
| 崩溃 | 杀掉浏览器，进程不退出且写下 crash.log |

---

## 18. 版本与演进

| 版本 | 变更 |
|---|---|
| v1.0 | 智慧树全章节跑通（138/148），固化 15 条踩坑 |

新增站点时：**只加适配器，不改引擎。** 若必须改引擎，说明规范有缺口，补进本文件。
