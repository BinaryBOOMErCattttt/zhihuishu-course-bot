'use strict';

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

function endpoint(baseUrl) {
  const b = (baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

async function chat(config, messages, tools, timeoutMs = 60000) {
  const apiKey = (config.apiKey || '').trim();
  if (!apiKey) throw new Error('未配置 DeepSeek API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = {
      model: config.model || DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      stream: false
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const res = await fetch(endpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data.error?.message || data.message || text.slice(0, 300);
      throw new Error('DeepSeek API ' + res.status + ': ' + msg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function heuristicQuiz({ question, options, type }) {
  const pos = /正确|应当|立即|及时|远离|拒绝|报警|拨打|求助|安全|不能|不要|禁止|保持|检查|关闭|逃生|自救|互救|遵守|合法|正规|官方|冷静|沟通|尊重|理解|包容|健康|适度|一律|必须|可以|需要|注意|防范|保护|报告|配合|听从|有序|湿毛巾|弯腰|低姿|空旷|坚固|通风|断电|灭火器|120|119|110/;
  const neg = /只要|所有|一定|随便|无所谓|不用|没必要|立即跳|乘坐电梯|贪便宜|隐瞒|独自|强行|翻越|推搡|拥挤|返回|围观|好奇|盲目|私自|违规|超载|酒驾|闯红灯|轻信|转账|点击链接|泄露/;
  const q = String(question || '');
  const scores = (options || []).map((o) => {
    const t = String(o || '');
    let s = 0;
    if (pos.test(t)) s += 2;
    if (neg.test(t)) s -= 3;
    if (/以上(都|均)?(对|正确)|全部(都)?正确|都是正确/.test(t)) s += 5;
    if (/以上(都|均)?(错|不对)|全部错误/.test(t)) s -= 5;
    // 总体国家安全观常见表述
    if (/宗旨/.test(q) && /人民安全/.test(t)) s += 12;
    if (/根本/.test(q) && /政治安全/.test(t)) s += 12;
    if (/基础/.test(q) && /经济安全/.test(t)) s += 12;
    if (/保障/.test(q) && /军事|科技|文化|社会安全/.test(t)) s += 8;
    if (/依托/.test(q) && /国际安全/.test(t)) s += 8;
    // 常见年份目标：2035 基本实现现代化 / 国家安全体系和能力全面加强
    if (/2035/.test(t) && /(发展目标|全面加强|基本实现|现代化|国家安全体系)/.test(q)) s += 12;
    if (/2030/.test(t) && /(碳达峰|2030)/.test(q)) s += 8;
    if (/2050/.test(t) && /(现代化强国|2050)/.test(q)) s += 8;
    return s;
  });
  if (/宗旨/.test(q) || /根本/.test(q) || /基础/.test(q) || /依托/.test(q)) {
    const best = Math.max(...scores);
    if (best >= 12) {
      const idx = scores.indexOf(best);
      return { indexes: [idx], reason: '使用总体国家安全观固定表述匹配', source: 'heuristic' };
    }
  }
  if (type === 'radio' || type === 'single') {
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    return { indexes: [best], reason: '未配置模型，使用安全常识关键词启发式选择', source: 'heuristic' };
  }
  const picked = scores.map((s, i) => s >= 0 ? i : -1).filter((i) => i >= 0);
  if (!picked.length) picked.push(0);
  return { indexes: picked, reason: '未配置模型，使用安全常识关键词启发式多选', source: 'heuristic' };
}

async function decideQuiz({ config, question, options, type, log }) {
  const fallback = heuristicQuiz({ question, options, type });
  if (!config.apiKey) return fallback;
  const n = (options || []).length;
  const tools = [{
    type: 'function',
    function: {
      name: 'answer_quiz',
      description: '提交这道题的答案。selected_indexes 是从 0 开始的选项下标数组。',
      parameters: {
        type: 'object',
        properties: {
          selected_indexes: {
            type: 'array',
            items: { type: 'integer', minimum: 0, maximum: Math.max(0, n - 1) },
            description: '正确选项的下标数组；单选只放一个'
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string', description: '一句话说明判断依据' }
        },
        required: ['selected_indexes', 'reason']
      }
    }
  }];
  const messages = [
    {
      role: 'system',
      content: '你是高校安全教育课程的答题助手。根据题目和选项选出正确答案，必须调用 answer_quiz 工具提交。优先选择符合安全常识、法律法规和官方表述的选项；不确定时选最稳妥、最不冒险的。不要输出工具调用之外的长篇解释。'
    },
    {
      role: 'user',
      content: JSON.stringify({ question: question || '', options: options || [], type: type || 'radio' }, null, 2)
    }
  ];
  for (let round = 0; round < 3; round++) {
    let data;
    try {
      data = await chat(config, messages, tools);
    } catch (e) {
      log?.('model_error', { msg: e.message });
      return { ...fallback, reason: fallback.reason + '（模型调用失败：' + e.message + '）' };
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) continue;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const call = msg.tool_calls.find((c) => c.function?.name === 'answer_quiz') || msg.tool_calls[0];
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      let picked = Array.isArray(args.selected_indexes) ? args.selected_indexes.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < n) : [];
      if (!picked.length) picked = fallback.indexes;
      if (type === 'radio' || type === 'single') picked = [picked[0]];
      return {
        indexes: [...new Set(picked)],
        reason: args.reason || '模型判断',
        confidence: args.confidence,
        source: 'deepseek'
      };
    }
    messages.push({ role: 'assistant', content: msg.content || '' });
    messages.push({ role: 'user', content: '请调用 answer_quiz 工具提交答案，不要只回复文字。' });
  }
  return fallback;
}

async function decideAction({ config, pageState, log }) {
  if (!config.apiKey) return { action: 'report_stuck', reason: '未配置模型，无法自动决策' };
  const tools = [
    {
      type: 'function',
      function: {
        name: 'click_selector',
        description: '点击页面上一个 CSS 选择器对应的元素。只使用页面状态中列出的选择器。',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string' }, reason: { type: 'string' } },
          required: ['selector', 'reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'wait',
        description: '等待一段时间，让页面动画或视频继续。',
        parameters: {
          type: 'object',
          properties: { ms: { type: 'integer', minimum: 200, maximum: 15000 }, reason: { type: 'string' } },
          required: ['ms', 'reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'reload',
        description: '刷新当前页面，用于页面卡死或加载不完整。',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'click_at',
        description: '按坐标点击页面。坐标使用 0-1 的相对值，x=0 是左边，y=0 是上边。适合 canvas、图片热区、小游戏等没有 CSS 按钮的交互。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', minimum: 0, maximum: 1 },
            y: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' }
          },
          required: ['x', 'y', 'reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'drag',
        description: '从起点拖拽到终点，坐标使用 0-1 的相对值。适合拼图、连线、拖拽分类类小游戏。',
        parameters: {
          type: 'object',
          properties: {
            from_x: { type: 'number', minimum: 0, maximum: 1 },
            from_y: { type: 'number', minimum: 0, maximum: 1 },
            to_x: { type: 'number', minimum: 0, maximum: 1 },
            to_y: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' }
          },
          required: ['from_x', 'from_y', 'to_x', 'to_y', 'reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'press_key',
        description: '按下键盘按键，例如 ArrowRight、Space、Enter。',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string' }, reason: { type: 'string' } },
          required: ['key', 'reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'request_human',
        description: '页面需要人工处理（例如图片验证码、未知交互），暂停并请求用户。',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'report_stuck',
        description: '无法判断如何继续，报告卡住。',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason']
        }
      }
    }
  ];
  const messages = [
    {
      role: 'system',
      content: '你是浏览器操作代理，负责把高校安全教育课程翻到下一页并完成。根据页面状态选择下一步，必须调用一个工具。优先使用 click_selector；如果页面是 canvas/图片热区/小游戏，使用 click_at；拖拽类游戏使用 drag；页面卡死可调用 reload；如果出现图片验证码或确实无法判断，调用 request_human。不要点击关闭、退出、删除等危险按钮。页面状态里的 elements 已包含可见元素的文本、class 和相对坐标中心点，可据此判断；pageState.history 是已经执行过的动作，不要重复无效操作。'
    },
    { role: 'user', content: JSON.stringify(pageState, null, 2) }
  ];
  try {
    const data = await chat(config, messages, tools, 30000);
    const msg = data.choices?.[0]?.message;
    if (msg?.tool_calls?.length) {
      const call = msg.tool_calls[0];
      const args = JSON.parse(call.function.arguments || '{}');
      return { action: call.function.name, ...args };
    }
  } catch (e) {
    log?.('model_error', { msg: e.message });
  }
  return { action: 'report_stuck', reason: '模型未返回有效工具调用' };
}

async function decideVision({ config, screenshotBase64, pageState, log }) {
  if (!config.apiKey || !screenshotBase64) return null;
  const tools = [
    {
      type: 'function',
      function: {
        name: 'click_at',
        description: '按截图坐标点击。坐标使用 0-1 的相对值，x=0 是左边，y=0 是上边。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', minimum: 0, maximum: 1 },
            y: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' }
          },
          required: ['x', 'y', 'reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'drag',
        description: '从起点拖拽到终点，坐标 0-1。',
        parameters: {
          type: 'object',
          properties: {
            from_x: { type: 'number' }, from_y: { type: 'number' },
            to_x: { type: 'number' }, to_y: { type: 'number' },
            reason: { type: 'string' }
          },
          required: ['from_x', 'from_y', 'to_x', 'to_y', 'reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'click_selector',
        description: '点击页面 CSS 选择器。',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string' }, reason: { type: 'string' } },
          required: ['selector', 'reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'wait',
        description: '等待动画或反馈。',
        parameters: {
          type: 'object',
          properties: { ms: { type: 'integer' }, reason: { type: 'string' } },
          required: ['ms', 'reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'request_human',
        description: '确实无法从截图判断时，请求人工。',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'report_stuck',
        description: '无法继续，报告卡住。',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason']
        }
      }
    }
  ];
  const messages = [
    {
      role: 'system',
      content: '你是课程互动页面的视觉操作代理。看截图和页面状态，判断当前小游戏/互动题应该点哪里。必须调用一个工具。优先使用 click_at 点击截图中正确的物品、选项、按钮；拖拽题用 drag；需要翻页时优先 click_selector。坐标是相对截图 0-1。不要点击关闭、退出、删除等危险区域。若截图已经出现“下一页/继续/完成”按钮，点击它。pageState.lastAttempt 是上一次动作；pageState.history 是已经点过的内容，不要重复点击已经点过且没有产生页面变化的目标，换一个物品或按钮。找物品游戏如果点了几次都没进展，先点击画面里的“提示”按钮/灯泡获取高亮提示。若确实看不清，调用 request_human。'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: JSON.stringify(pageState, null, 2) },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + screenshotBase64, detail: 'high' } }
      ]
    }
  ];
  try {
    const data = await chat({ ...config, model: config.visionModel || 'deepseek-flash' }, messages, tools, 90000);
    const msg = data.choices?.[0]?.message;
    if (msg?.tool_calls?.length) {
      const call = msg.tool_calls[0];
      const args = JSON.parse(call.function.arguments || '{}');
      return { action: call.function.name, ...args, vision: true };
    }
  } catch (e) {
    log?.('vision_error', { msg: e.message });
  }
  return null;
}

async function testConnection(config) {
  const data = await chat(config, [
    { role: 'system', content: '只回复 OK 两个字母。' },
    { role: 'user', content: 'ping' }
  ], null, 20000);
  return data.choices?.[0]?.message?.content || 'OK';
}

module.exports = { chat, decideQuiz, decideAction, decideVision, heuristicQuiz, testConnection, DEFAULT_BASE, DEFAULT_MODEL };