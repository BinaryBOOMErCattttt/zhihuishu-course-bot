# 刷题 / 刷课 自动化框架

站点无关的机械性学习自动化工具。**智慧树是参考实现，不是限制。**

换一个站点时，只写一个 `adapters/<site>.js`，引擎、题库、复核、自愈、控制台全部复用。

## 为什么这么分层

```text
┌──────────────────────────────────────────┐
│ L5 控制台 UI     进度 / 计时 / 人工接管      │
│ L4 运行时        启动/暂停/预算/调度         │
│ L3 适配器        单元/答题/解析  ← 只写这层   │
│ L2 通用引擎      题库/匹配/点击/复核/验证码   │
│ L1 浏览器        标签页/页面/坐标/人类化输入  │
└──────────────────────────────────────────┘
```

## 三条不可违反的规则

**1. 内容优先**
选项顺序随机是常态。一切匹配基于文本内容，**绝不基于 A/B/C/D 位置**。

**2. 可见优先**
只操作 `offsetParent !== null` 的元素。DOM 里存在 ≠ 可点击。

**3. 先验后交**
提交前逐题翻页复核选中态，任何不一致**拒绝提交**。

## 快速开始

```bash
npm install
cp config.example.json config.json     # 填 apiKey / studyUrl / profileDir
npm start                              # 浏览器打开 http://127.0.0.1:4319
```

首次启动后在弹出的 Edge 里登录，登录态保存在 `profileDir`。

## 命令行

```bash
npm run check                        # 适配器契约自检
npm test                             # 全量测试（引擎/题库/计时/离线自主）

node cli.js summary                  # 成绩汇总
node cli.js exam-list                # 打开考试列表
node cli.js exam-dump 第五章单元测试   # 只扒题
node cli.js exam-dry 第五章单元测试    # 纯题库试跑，不提交
node cli.js exam-run 第五章单元测试    # 试跑 + 复核 + 提交
node cli.js bank-verify <examId>     # 题库选项反转验证
node cli.js pages                    # 标签页列表
```

## 文档

| 文件 | 内容 |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | **通用规范** —— 18 节，含 15 条实测踩坑 |
| [docs/PORTING.md](docs/PORTING.md) | **移植指南** —— 从零适配新站点的完整流程 |
| [adapters/_template.js](adapters/_template.js) | 适配器模板（20 方法 + 7 选择器） |
| [adapters/zhihuishu.js](adapters/zhihuishu.js) | 智慧树参考实现（全部选择器实测） |

## 目录

```text
adapters/            站点适配器（唯一站点相关代码）
  _template.js       空模板
  zhihuishu.js       智慧树参考实现
lib/
  generic/           通用引擎（站点无关）
    exam-runner.js   答题流程：命中→点选→复核→提交
  bot.js             智慧树引擎（视频/弹题/自愈/题库）
  deepseek.js        模型调用
tools/
  adapter-check.js   适配器契约自检
tests/               全部离线，不需要浏览器
public/              网页控制台
docs/                规范与指南
server.js            本地 HTTP 服务
cli.js               命令行入口
```

## 测试

```text
engine.test.js            通用引擎：dryRun 不点不提交 / 缺题阻塞 / 复核拦篡改 / 文本差异不误命
bank_mapping.test.js      题库：选项反转后 100% 命中
timer_once.test.js        计时：到上限提醒一次，第二次允许继续
autonomy_offline.test.js  离线自主：断开模型 API 仍能完成全部判题
```

当前全部通过：

```text
engine      5/5
bank        77 / 77
offline     370 / 370  (7 场考试 74 题 ×5 轮)
```

## 实测成绩

智慧树《大学生心理健康教育》全 7 章：

| 章节 | 分数 |
|---|---|
| 第一章 | 18 / 20 |
| 第二章 | 20 / 20 |
| 第三章 | 28 / 32 |
| 第四章 | 16 / 16 |
| 第五章 | 20 / 20 |
| 第六章 | 16 / 20 |
| 第七章 | 20 / 20 |
| **合计** | **138 / 148 (93.2%)** |

## 已知坑（15 条见 docs/SPEC.md 第 16 节）

| 现象 | 根因 |
|---|---|
| 点选项无反应 | 目标是隐藏 block |
| 选中态永远 false | 页面不加 `onChecked` 类，状态在 `img.src` |
| 各章互相串题 | examId 只取了数字段 |
| 文本一样但匹配失败 | 全角 `º`/`°`、`－`/`—` 差异 |
| 考试列表空白 | 裸跳 SPA 路由，无上下文 |
| 单选改不过来 | 重做页预置上轮答案 |

## 隐私

`config.json`、`profile/`、`data/`、`shots/`、`app.log` 全部本地运行数据，不要提交。

## 免责

仅供个人学习研究。使用前确认符合所在平台服务条款与学校规定，风险自负。
