'use strict';

const $ = (id) => document.getElementById(id);
let S = null;
let dismissedErrorAt = '';
$('errorAck').addEventListener('click', () => { dismissedErrorAt = S?.lastError?.at || ''; $('errorBanner').classList.remove('show'); });
let currentTab = 'dashboard';
let courseFilter = 'all';
let courseSearch = '';
let captchaPoints = [];
let captchaImageKey = '';
let lastLogKey = '';
let shotVersion = -1;
let configLoaded = false;

const STATUS = {
  idle: ['待启动', '浏览器未连接', '先启动浏览器', '启动后会自动打开课程页；已登录会直接进入。', ''],
  ready: ['浏览器已连接', '可以开始刷课', '准备就绪', '课程列表已加载，点「开始刷课」即可。', 'ok'],
  login_required: ['等待登录', '需要在浏览器中登录', '请先登录', '学校/账号已填好，请在浏览器完成图形验证码并点登录。', 'warn'],
  running: ['运行中', '正在自动翻页', '正在刷课', '脚本正在逐门完成课程，遇到视频会等待播放结束。', 'running'],
  paused: ['已暂停', '暂停在当前页', '已暂停', '点「继续」从当前页接着跑。', 'warn'],
  captcha: ['等待验证码', '需要人工点击图片', '需要验证', '右侧弹出验证码窗口，按提示顺序点击图片中的字符。', 'warn'],
  waiting_human: ['等待人工', '脚本停在当前页', '需要人工处理', '查看日志和浏览器画面，处理后点继续。', 'warn'],
  error: ['出错', '已停止在当前课程', '出错了', '查看日志中的红色记录，修复后重新开始。', 'bad'],
  done: ['全部完成', '85 门课程已刷完', '全部完成', '可以关闭浏览器，或到学习足迹确认成绩。', 'ok'],
  stopped: ['已停止', '手动停止', '已停止', '点「开始刷课」可以继续未完成课程。', ''],
  browser_ready: ['浏览器已连接', '可以开始', '准备就绪', '点「开始刷课」运行。', 'ok']
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 3600);
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return ''; }
}
function fmtDuration(ms) {
  if (!ms || ms < 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
function statusInfo(st) {
  return STATUS[st] || [st || '未知', '', '—', '', ''];
}

function applyStatus(s) {
  const [label, sub, title, desc, tone] = statusInfo(s.status);
  $('statusPill').textContent = label;
  $('statusPill').className = 'pill ' + (tone === 'running' ? 'running' : tone === 'bad' ? 'error' : tone === 'warn' ? 'warn' : '');
  $('sideStatus').textContent = label;
  $('sideSub').textContent = sub;
  $('sideDot').className = 'status-dot ' + (tone === 'running' || tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'bad' ? 'bad' : '');
  $('heroTitle').textContent = title;
  $('heroDesc').textContent = desc;

  const done = Number(s.done || 0), total = Number(s.total || 85);
  $('ringDone').textContent = done;
  $('ringTotal').textContent = total;
  $('ring').style.setProperty('--p', total ? Math.min(100, Math.round(done / total * 100)) : 0);
  $('statDone').textContent = done;
  $('statPending').textContent = Math.max(0, total - done);
  const remaining = Math.max(0, total - done);
  $('statEta').textContent = remaining ? Math.ceil(remaining * 0.7) + ' 分钟' : '完成';
  $('currentCourse').textContent = s.currentCourse?.resourceName || '—';
  $('currentMeta').textContent = s.currentCourse ? (s.currentCourse.categoryName || '') + ' · ' + (s.currentCourse.resourceName || '') : (s.browserReady ? '等待开始' : '浏览器未连接');
  $('modelName').textContent = s.config?.model || 'DeepSeek';

  $('launchBtn').disabled = false;
  $('launchBtn').textContent = s.browserReady ? '重开浏览器' : '启动浏览器';
  $('startBtn').disabled = !(s.browserReady && s.loggedIn) || s.running;
  $('pauseBtn').disabled = !s.running && !s.paused;
  $('pauseBtn').textContent = s.paused ? '继续' : '暂停';
  $('stopBtn').disabled = !s.running && !s.paused && s.status !== 'captcha';
  $('loginTopBtn').style.display = s.loggedIn ? 'none' : 'inline-block';

  if (s.config) $('modelSource').textContent = s.lastModel?.source === 'deepseek' ? 'DeepSeek 已决策' : (s.lastModel?.source === 'heuristic' ? '启发式规则' : '待命');
  if (s.lastModel) {
    $('modelBox').innerHTML = '<b>' + esc(s.lastModel.kind === 'quiz' ? '答题决策' : '页面决策') + '</b> · ' +
      esc(s.lastModel.reason || '') +
      (Array.isArray(s.lastModel.picked) ? '<br>选择：' + s.lastModel.picked.map(i => '选项 ' + (i + 1)).join('、') : '') +
      (s.lastModel.question ? '<br><span class="muted">题目：' + esc(s.lastModel.question) + '</span>' : '');
  }
}

function renderShot(s) {
  const wrap = document.querySelector('.shot');
  if (s.browserReady) {
    if (s.screenshotVersion !== shotVersion) {
      shotVersion = s.screenshotVersion;
      const img = $('shot');
      img.onload = () => { wrap.classList.add('has-img'); };
      img.src = '/api/screenshot?v=' + shotVersion;
      $('shotTime').textContent = '刚刚';
    }
  } else {
    wrap.classList.remove('has-img');
    $('shotTime').textContent = '—';
  }
}

const EVENT_CN = {
  browser_launch: '浏览器', progress: '进度', run_start: '开始', course_begin: '开课', open_course: '打开',
  course_start: '课程', start_clicked: '启动', page: '翻页', answer_map: '答案', quiz_static: '答题', quiz_model: 'AI答题',
  quiz_ok: '答对', quiz_wrong: '答错', video: '视频', video_wait: '视频等待', video_end: '视频结束',
  course_done: '完成', comment_back: '返回列表', captcha_detected: '验证码', captcha_wait: '验证码', captcha_solved: '验证通过',
  captcha_retry: '验证失败', paused: '暂停', resumed: '继续', stopped: '停止', stop_requested: '停止中',
  login_required: '登录', login_opened: '登录页', login_filled: '填表', login_success: '登录成功',
  model_error: '模型错误', course_error: '课程错误', fatal: '致命错误', answer_map_error: '答案错误',
  stuck_state: '卡住', stuck_decision: 'AI决策', request_human: '需人工', all_done: '全部完成', run_start: '开始'
};
function logKey(e) { return e.t + '|' + e.event; }
function logLine(e) {
  const label = EVENT_CN[e.event] || e.event;
  const parts = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === 't' || k === 'event' || v == null || v === '') continue;
    if (typeof v === 'object') {
      try { parts.push(k + '=' + JSON.stringify(v).slice(0, 160)); } catch {}
    } else parts.push(k + '=' + String(v).slice(0, 160));
  }
  const bad = /error|fatal|wrong|retry|required|stuck|卡|失败/i.test(e.event);
  const warn = /captcha|pause|human|warn/i.test(e.event);
  return '<div class="log-line ' + (bad ? 'err' : warn ? 'warn' : '') + '"><span class="log-time">' + fmtTime(e.t) + '</span><span class="log-event">' + esc(label) + '</span><span class="log-msg">' + esc(parts.join(' · ')) + '</span></div>';
}
function renderLogs(s) {
  const box = $('logs');
  const logs = s.logs || [];
  if (!logs.length) { box.innerHTML = '<div class="log-line"><span class="log-msg">暂无日志，启动浏览器后开始记录。</span></div>'; lastLogKey = ''; return; }
  const newKey = logKey(logs[logs.length - 1]);
  if (newKey === lastLogKey) return;
  const existing = new Set([...box.querySelectorAll('.log-line')].map(x => x.dataset.key).filter(Boolean));
  for (const e of logs) {
    const k = logKey(e);
    if (existing.has(k)) continue;
    const div = document.createElement('div');
    div.innerHTML = logLine(e);
    const line = div.firstElementChild;
    line.dataset.key = k;
    box.appendChild(line);
  }
  while (box.children.length > 220) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  lastLogKey = newKey;
}

function renderCourses(s) {
  const all = s.catalog || [];
  $('navCount').textContent = all.length;
  const q = courseSearch.trim().toLowerCase();
  const rows = all.filter(c => {
    if (courseFilter === 'done' && c.status !== 'done') return false;
    if (courseFilter === 'pending' && c.status === 'done') return false;
    if (q && !((c.resourceName || '') + ' ' + (c.categoryName || '')).toLowerCase().includes(q)) return false;
    return true;
  });
  const body = $('courseBody');
  body.innerHTML = rows.map((c, i) => {
    const now = s.currentCourse?.userCourseId === c.userCourseId;
    const st = c.status === 'done' ? '<span class="badge done">已完成</span>' : now ? '<span class="badge now">进行中</span>' : '<span class="badge pending">待完成</span>';
    const pct = c.status === 'done' ? 100 : now ? 45 : 0;
    return '<tr><td class="idx">' + (i + 1) + '</td><td class="name">' + esc(c.resourceName) + '</td><td class="cat">' + esc(c.categoryName) + '</td><td>' + st + '</td><td><div class="progress-mini"><i style="width:' + pct + '%"></i></div></td></tr>';
  }).join('') || '<tr><td colspan="5" style="color:#5f7488;padding:24px">没有匹配的课程</td></tr>';
}

function renderHuman(s) {
  const m = $('humanModal');
  if (!s.attention) { m.classList.remove('show'); return; }
  m.classList.add('show');
  $('humanTitle').textContent = s.attention.title || '需要人工处理';
  $('humanMsg').textContent = s.attention.message || '请在浏览器里完成验证，然后点“我已处理，继续”。';
  const img = $('humanImg');
  if (s.attention.image) img.src = s.attention.image + '&t=' + Date.now();
}

function renderCaptcha(s) {
  const modal = $('captchaModal');
  if (!s.captcha) { modal.classList.remove('show'); return; }
  modal.classList.add('show');
  const key = s.captcha.image;
  if (key !== captchaImageKey) {
    captchaImageKey = key;
    captchaPoints = [];
    $('captchaImg').src = key + (key.includes('?') ? '&' : '?') + 't=' + Date.now();
    $('captchaHeader').textContent = (s.captcha.header || '请按顺序点击图片中的字符') + (s.captcha.answer ? ' ' + s.captcha.answer : '');
    drawMarks();
  }
  $('captchaHint').textContent = captchaPoints.length ? '已点击 ' + captchaPoints.length + ' 个，按顺序继续' : '点击顺序：';
}

function drawMarks() {
  const box = $('captchaMarks');
  box.innerHTML = captchaPoints.map((p, i) => '<div class="mark" style="left:' + (p.x * 100) + '%;top:' + (p.y * 100) + '%">' + (i + 1) + '</div>').join('');
}

function renderError(s) {
  const box = $('errorBanner');
  if (!s.lastError || !s.lastError.at || s.lastError.at === dismissedErrorAt) { box.classList.remove('show'); return; }
  box.classList.add('show');
  $('errorText').textContent = s.lastError.event + ' · ' + (s.lastError.message || '') + '（累计 ' + (s.errorCount || 0) + ' 次）';
}

function render(s) {
  S = s;
  applyStatus(s);
  renderShot(s);
  renderLogs(s);
  renderCourses(s);
  renderHuman(s);
  renderCaptcha(s);
  renderError(s);
  const elapsed = s.startedAt && (s.running || s.status === 'running' || s.status === 'paused' || s.status === 'captcha') ? Date.now() - new Date(s.startedAt).getTime() : 0;
  $('elapsed').textContent = fmtDuration(elapsed);
}

async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const s = await r.json();
    if (s.ok) {
      render(s);
      if (!configLoaded) { configLoaded = true; loadConfig(); }
    }
  } catch (e) { /* ignore */ }
}

async function loadConfig() {
  try {
    const r = await api('/api/config');
    const c = r.config;
    $('school').value = c.school || '';
    $('speed').value = String(c.speed || 1);
    $('account').value = c.account || '';
    $('baseUrl').value = c.baseUrl || 'https://api.deepseek.com';
    $('model').value = c.model || 'deepseek-chat';
    $('visionModel').value = c.visionModel || 'deepseek-flash';
    $('profileDir').value = c.profileDir || '';
    $('pageDelayMs').value = c.pageDelayMs || 650;
    $('headless').checked = Boolean(c.headless);
    $('quizMode').value = c.quizMode || 'brute';
    $('modelResident').checked = c.modelResident !== false;
    $('apiKey').value = '';
    $('apiKey').placeholder = r.hasKey ? '已保存，留空不修改' : 'sk-...';
    $('password').value = '';
    $('password').placeholder = r.hasPassword ? '已保存，留空不修改' : '留空则保持不变';
    $('keyTag').textContent = r.hasKey ? ('已配置 · 尾号 ' + (c.keyTail || '')) : '未配置';
    $('keyTag').style.color = r.hasKey ? 'var(--accent)' : 'var(--warn)';
    $('helpDir').textContent = c.profileDir || '';
  } catch (e) { toast(e.message, true); }
}

async function saveConfig() {
  const body = {
    school: $('school').value.trim(),
    speed: Number($('speed').value) || 1,
    account: $('account').value.trim(),
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    visionModel: $('visionModel').value.trim(),
    profileDir: $('profileDir').value.trim(),
    pageDelayMs: Number($('pageDelayMs').value) || 650,
    quizMode: $('quizMode').value || 'brute',
    modelResident: $('modelResident').checked,
    headless: $('headless').checked
  };
  if ($('apiKey').value.trim()) body.apiKey = $('apiKey').value.trim();
  if ($('password').value) body.password = $('password').value;
  try { await api('/api/config', { method: 'POST', body }); toast('设置已保存'); $('apiKey').value = ''; $('password').value = ''; loadConfig(); }
  catch (e) { toast(e.message, true); }
}

async function testModel() {
  $('testModelMsg').textContent = '测试中…';
  try {
    if ($('apiKey').value.trim() || $('password').value) await saveConfig();
    const r = await api('/api/test-model', { method: 'POST' });
    $('testModelMsg').textContent = '连接成功：' + (r.message || 'OK');
    $('testModelMsg').style.color = 'var(--accent)';
  } catch (e) {
    $('testModelMsg').textContent = e.message;
    $('testModelMsg').style.color = 'var(--danger)';
  }
}

async function action(fn, label) {
  try { await fn(); toast(label); setTimeout(poll, 500); }
  catch (e) { toast(e.message, true); }
}

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  const titles = { dashboard: ['控制台', '登录一次，剩下的交给脚本'], courses: ['课程列表', '85 门必修课程，按分类整理'], settings: ['设置', '账号、模型与浏览器'], help: ['使用说明', '第一次用先看这里'] };
  $('tabTitle').textContent = titles[name][0];
  $('tabSub').textContent = titles[name][1];
}

document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('launchBtn').addEventListener('click', () => action(async () => {
  $('launchBtn').disabled = true;
  $('launchBtn').textContent = '启动中…';
  await api('/api/browser/launch', { method: 'POST' });
  await poll();
}, '浏览器已启动'));
$('startBtn').addEventListener('click', () => action(async () => {
  if (!S?.loggedIn) { await api('/api/login', { method: 'POST' }); toast('已打开登录页，请先在浏览器完成验证码'); return; }
  await api('/api/start', { method: 'POST' });
}, '已开始刷课'));
$('aiStepBtn').addEventListener('click', async () => {
  try {
    toast('AI 正在判断当前页…');
    const r = await api('/api/ai/step', { method: 'POST' });
    const d = r.decision || {};
    const detail = 'AI ' + (r.handled ? '已执行' : '未执行') + ' · ' + (d.action || '无动作') + (d.reason ? ' · ' + d.reason : '');
    toast(detail, !r.handled);
    await poll();
  } catch (e) {
    toast('AI 调用失败：' + e.message, true);
  }
});

$('reloadBtn').addEventListener('click', async () => {
  try {
    toast('正在热重载脚本，不关闭浏览器…');
    const r = await api('/api/reload', { method: 'POST' });
    toast('热重载完成：' + r.methods + ' 个方法，浏览器保持打开', false);
    await poll();
  } catch (e) {
    toast('热重载失败：' + e.message, true);
  }
});
$('pauseBtn').addEventListener('click', () => action(async () => {
  if (S?.paused) await api('/api/resume', { method: 'POST' });
  else await api('/api/pause', { method: 'POST' });
}, S?.paused ? '已继续' : '已暂停'));
$('stopBtn').addEventListener('click', () => action(() => api('/api/stop', { method: 'POST' }), '已请求停止'));
$('refreshBtn').addEventListener('click', () => action(async () => { await api('/api/refresh', { method: 'POST' }); await poll(); }, '已刷新'));
$('loginTopBtn').addEventListener('click', () => action(() => api('/api/login', { method: 'POST' }), '已打开登录页，请在浏览器完成验证码'));
$('loginBtn').addEventListener('click', () => action(() => api('/api/login', { method: 'POST' }), '已打开登录页，请在浏览器完成验证码'));
$('saveConfigBtn').addEventListener('click', saveConfig);
$('testModelBtn').addEventListener('click', testModel);
$('clearLogBtn').addEventListener('click', () => { $('logs').innerHTML = ''; lastLogKey = ''; });

async function sendDebug() {
  const input = $('debugInput');
  const msg = input.value.trim();
  if (!msg) return;
  const box = $('debugAnswer');
  box.classList.add('show');
  box.textContent = '模型思考中…';
  $('debugSend').disabled = true;
  try {
    const r = await api('/api/debug/chat', { method: 'POST', body: { message: msg } });
    const acts = Array.isArray(r.actions) && r.actions.length ? '\n\n执行动作：' + r.actions.map(a => a.tool).join(' → ') : '\n\n（本次没有执行动作）';
    box.textContent = '你：' + msg + '\n\nAI：' + (r.answer || '(无返回)') + acts;
    input.value = '';
    await poll();
  } catch (e) {
    box.textContent = '调用失败：' + e.message;
    toast('模型调试失败：' + e.message, true);
  } finally {
    $('debugSend').disabled = false;
  }
}
$('debugSend').addEventListener('click', sendDebug);
$('debugInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDebug(); } });
$('courseSearch').addEventListener('input', (e) => { courseSearch = e.target.value; if (S) renderCourses(S); });
$('courseFilters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  courseFilter = b.dataset.filter;
  document.querySelectorAll('#courseFilters .chip').forEach(x => x.classList.toggle('active', x === b));
  if (S) renderCourses(S);
});

$('captchaStage').addEventListener('click', (e) => {
  const img = $('captchaImg');
  if (!img || !img.naturalWidth) return;
  const r = img.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  captchaPoints.push({ x, y });
  drawMarks();
  $('captchaHint').textContent = '已点击 ' + captchaPoints.length + ' 个，按顺序继续';
});
$('captchaReset').addEventListener('click', () => { captchaPoints = []; drawMarks(); $('captchaHint').textContent = '点击顺序：'; });
$('captchaSubmit').addEventListener('click', async () => {
  if (!captchaPoints.length) return toast('请先按顺序点击图片', true);
  try {
    const r = await api('/api/captcha', { method: 'POST', body: { points: captchaPoints } });
    if (r.ok === false) toast(r.message || '未通过，请重试', true);
    else { toast('验证已提交'); captchaPoints = []; drawMarks(); }
    captchaImageKey = '';
    setTimeout(poll, 600);
  } catch (e) { toast(e.message, true); }
});
$('humanAck').addEventListener('click', () => action(async () => {
  await api('/api/attention/ack', { method: 'POST' });
  $('humanModal').classList.remove('show');
  await poll();
}, '已继续'));
$('humanClose').addEventListener('click', () => $('humanModal').classList.remove('show'));
$('captchaClose').addEventListener('click', () => { $('captchaModal').classList.remove('show'); });

setInterval(poll, 1200);
setInterval(() => {
  if (!S) return;
  const running = S.running || S.status === 'running' || S.status === 'paused' || S.status === 'captcha';
  if (running && S.startedAt) $('elapsed').textContent = fmtDuration(Date.now() - new Date(S.startedAt).getTime());
}, 1000);
poll();