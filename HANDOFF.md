# HANDOFF — Zhihuishu Course Bot

> 给下一个接手的 agent：先读完本文件，再动代码。
> 本文件不包含任何账号、密码、API Key、学校名或浏览器配置。

## 1. 项目是什么

一个本地 Web GUI + Playwright 浏览器自动化工具，用来处理智慧树（Zhihuishu）**共享课**的视频学习和章节测试。

不是官方客户端，不绕过登录，不修改平台数据；只操作真实浏览器里的页面。

当前目标课程结构（以实际扫描为准）：

- 约 62 个视频
- 7 个「平时测试」
- 视频中会随机弹「弹题」（判断题/单选题/多选题）
- 偶尔出现腾讯滑块/拼图人机验证
- 全部视频看完后，才进入单独的「平时测试」阶段

## 2. 当前状态（截至交接）

- GUI 可启动：`http://127.0.0.1:4319`
- 智慧树共享课登录态保存在 `profile/`（已 gitignore）
- 视频列表扫描：**62 条**
- 已完成视频：**4 / 62**（以平台 `time_icofinish` 标记为准）
- 视频播放：**1x**，等待自然结束
- 单条视频已验证：
  - 1.2《大学生心理健康的现状及特点》
  - 472.49 / 472.49 秒
  - 结束后 `video_done`，未自动跳下一条
- 课后测试阶段：**尚未实现**（见第 7 节）

## 3. 目录结构

```text
server.js              HTTP API + 静态 GUI，默认端口 4319
lib/bot.js             Playwright 主流程：登录、扫描、点视频、播放、弹窗、AI
lib/deepseek.js        DeepSeek chat / vision / quiz / action 封装
public/index.html      GUI
public/app.js          前端轮询、日志、设置、AI 按钮、人工验证弹窗
public/style.css       样式
config.example.json    配置模板（无隐私）
Dockerfile             云端镜像
docker-compose.yml     云端编排
DEPLOY.md              云端部署说明
HANDOFF.md             本文件
```

运行时生成、已 gitignore：

```text
config.json            用户本地配置（Key、账号、studyUrl）
profile/               Playwright 持久化浏览器配置（登录态）
data/state.json        本地进度
shots/                 截图
app.log                结构化日志
```

## 4. 关键流程（lib/bot.js）

### 4.1 启动

`launch()`
- 用 `playwright` 启动持久化 context
- Windows 默认 `channel=msedge`；Linux/容器默认使用 Playwright Chromium
- 打开 `studyUrl`
- `detectLogin()` 判断是否登录
- 已登录 → `prepareCourse()`；未登录 → `login_required`

### 4.2 课程页准备

`prepareCourse()`
- `ensureStudyPage()`：始终切到 `studyvideoh5.zhihuishu.com/stuStudy` 这个 tab，避免切换到首页
- `closeMasks()`：关闭「学前必读」「课程提醒」「温馨提示」并移除 `.mask`
- `scanVideos()`：读 `li.video`，得到编号、标题、时长、`time_icofinish`

### 4.3 视频循环

`runLoop()`
1. 跳过 `finished` 的视频
2. `clickVideo(i)`：只点 `.catalogue_title`，不点整个 `li`（点 li 可能跳首页）
3. 校验 `.videotop_lesson_tit` 是否包含目标标题
4. `playCurrent(i)`：
   - 1x 播放
   - 每秒检查 `video.currentTime / duration / paused / ended`
   - 有弹窗 → `handleOverlay()`
   - 到 `duration - 0.8` 或 `ended` → 完成
5. 标记 `finished`，写 `data/state.json`

### 4.4 弹窗优先级

`handleOverlay()`：

```text
人机验证？
  → 是：AI 尝试 drag/click；失败弹人工 modal
  → 否：弹题？
      → 是：提取题干 + A/B/C/D 选项，调用 decideQuiz
      → 否：通用 AI 决策（截图 + DOM）
```

弹题日志：

```text
popup_quiz_detected
popup_quiz_model
popup_quiz_vision
```

### 4.5 人工验证

`isHumanVerification()` 检查 `#tcaptcha_transform_dy` 的：
- `display`
- `visibility`
- `opacity`
- `getBoundingClientRect().top/width/height`

不能只看 iframe 是否存在：腾讯 iframe 一直存在但隐藏。

失败时：

```text
status = waiting_human
attention = { title, message, image }
```

GUI 弹出 `#humanModal`，用户点「我已处理，继续」→ `POST /api/attention/ack`。

### 4.6 手动 AI 调试

- GUI 按钮：「AI 接管当前页」
- API：`POST /api/ai/step`
- 日志输入框：`POST /api/debug/chat`
- 调试框只做分析，不执行动作；`aiStep` 会执行一次动作

## 5. 当前已验证

- 单条视频 1x 播完
- 平台完成标记增加
- 视频结束后停在当前页，没有继续跑
- 视频切换：只点标题 + 标题校验
- 弹题：已能识别文本型判断题/单选题，调用模型
- 手动 AI：`/api/ai/step` 200，返回 `click_at` + reason
- 调试输入框：`/api/debug/chat` 200，返回页面状态分析

## 6. 已知问题 / 易踩坑

1. **点击 `li.video` 会跳首页**
   - 只能点 `.catalogue_title`，不要点 li
2. **`.mask` 会残留**
   - `closeMasks()` 里移除 `.mask`，并移除「学前必读/课程提醒」弹窗
3. **腾讯 iframe 常驻**
   - 必须用 `#tcaptcha_transform_dy` 的 opacity/rect 判断，不能 count iframe
4. **登录态在 profile/**
   - 不要提交 profile；Docker 首次登录需要桌面/VNC 或复制已登录 profile
5. **视频进度本地记录可能和平台不同步**
   - 启动时 `scanVideos()` 以平台 `time_icofinish` 为准
6. **弹题选项可能是图片**
   - 文本提取不到 ≥2 个选项时走 `decidePage()` 视觉兜底
7. **课后测试还没实现**
   - 见第 7 节

## 7. 下一步：课后测试阶段（必须单独做）

需求：**全部视频看完后**，再统一做「平时测试」，不要混进视频循环。

入口：

- 课程页 `li.chapter-test`，共 7 个
- 点击后打开新 tab：
  `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/...`
- 每个测试约 10 道选择题，题干/选项在 `.examPaper_subject`、`.nodeLab`、`.node_detail`
- 提交按钮：「提交作业」

建议实现：

```js
async runTests() {
  if (!this.videos.every(v => v.finished)) return;
  this.status = 'tests';
  // 逐个 li.chapter-test：
  // 1. 点击，等待新 page
  // 2. 切到 onlineexamh5new page
  // 3. 提取当前题：题干 + 选项
  // 4. decideQuiz() 选择
  // 5. 点「下一题」
  // 6. 最后一题点「提交作业」并确认
  // 7. 关闭 tab，回课程页
}
```

注意：

- 测试页是独立 tab，要 `context.pages()` 找 URL
- 选项顺序随机，必须以选项文本为准
- 不要自动提交未答完的卷子
- 提交前记录日志和截图

## 8. 配置 / 环境变量

配置模板见 `config.example.json`。

关键字段：

| 字段 | 说明 |
|---|---|
| `studyUrl` | 共享课 `stuStudy?recruitAndCourseId=...` |
| `apiKey` | DeepSeek Key，建议用环境变量 |
| `model` | 默认 `deepseek-chat` |
| `visionModel` | 默认 `deepseek-flash` |
| `profileDir` | 默认 `./profile` |
| `browserChannel` | Windows `msedge`；Linux 留空 |
| `headless` | 云端 `true` |
| `speed` | 默认 `1`，不要加速 |

环境变量：

```text
PORT=4319
HOST=127.0.0.1
DEEPSEEK_API_KEY=...
STUDY_URL=...
HEADLESS=false
BROWSER_CHANNEL=
PROFILE_DIR=./profile
SPEED=1
```

## 9. 开发命令

```bash
npm install
npx playwright install chromium   # Linux
npm start
# GUI: http://127.0.0.1:4319
```

Windows 本地可直接用 Edge，不需要下载 Chromium。

## 10. 部署

见 `DEPLOY.md`：

```bash
cp .env.example .env
docker compose up -d --build
```

安全：

- 不要把 4319 直接暴露公网
- 用 SSH 隧道 / VPN / Nginx + HTTPS + 认证
- 不要提交 `config.json`、`profile/`、`data/`、`shots/`、`app.log`

## 11. 交接 checklist

- [ ] 读 `lib/bot.js` 的 `runLoop/clickVideo/playCurrent/handleOverlay`
- [ ] 读 `lib/deepseek.js` 的 `decideQuiz/decideVision/decideAction`
- [ ] 确认 `studyUrl` 是共享课，不是公开课
- [ ] 用 1x 跑一条完整视频，确认 `time_icofinish` 增加
- [ ] 实现 `runTests()`，不要混进视频循环
- [ ] 测一次视频弹题（判断/单选/多选）
- [ ] 测一次人机验证失败 → GUI modal → ack 继续
- [ ] 更新 README / HANDOFF
