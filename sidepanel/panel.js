/* 侧边栏逻辑：通过 chrome.runtime.connect 与 background 建长连接，
 * 渲染四个 AI 的在线状态、展示派发记录与回答消息流。
 * 回答是纯文本展示（保留换行），并做 HTML 转义防止注入。
 *
 * 名字与 @ 功能：
 * - 每个 AI 有可自定义的显示名（存在 chrome.storage.local），点击顶部名字可改名
 * - 输入框支持 @名字：只把消息发给被 @ 的 AI；不加 @ 则群发给所有在线 AI
 * - 初始化时在消息流顶部强调每个人的名字与 @ 用法
 */
(function () {
  'use strict';

  const AGENT_META = {
    chatgpt: { defaultName: 'ChatGPT', color: '#10a37f', letter: 'G' },
    claude: { defaultName: 'Claude', color: '#c15f3c', letter: 'C' },
    gemini: { defaultName: 'Gemini', color: '#1a73e8', letter: 'Ge' },
    deepseek: { defaultName: 'DeepSeek', color: '#4d6bfe', letter: 'D' },
  };
  const ORDER = ['chatgpt', 'claude', 'gemini', 'deepseek'];
  const STORE_KEY = 'miao_agent_names';

  const $ = (id) => document.getElementById(id);
  const agentBar = $('agent-bar');
  const messagesEl = $('messages');
  const promptEl = $('prompt');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const popupEl = $('mention-popup');

  let agents = {}; // agentId -> { name, online, tabId }（name 来自 background，仅作参考）
  let customNames = {}; // agentId -> 自定义显示名（storage 持久化）
  let running = 0; // 进行中的子任务数
  const pendingBubbles = {}; // `${taskId}:${agentId}` -> .text 元素（用于原地更新状态）
  let introEl = null; // 初始化介绍消息的引用，改名时同步更新

  const port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(handleBackgroundMessage);

  /** HTML 转义：回答文本不可信，必须转义后再插入 */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  /** 显示名：自定义名优先，否则默认名 */
  function displayName(id) {
    return customNames[id] || AGENT_META[id].defaultName;
  }

  /** @ 匹配用的别名集合：显示名、默认名、id（小写） */
  function aliases(id) {
    const set = new Set();
    for (const n of [displayName(id), AGENT_META[id].defaultName, id]) {
      set.add(String(n).toLowerCase());
    }
    return set;
  }

  /**
   * 解析输入中的 @提及（@ 前面必须是开头或空白，避免把邮箱当成提及）。
   * 返回 { mentioned: [agentId...], clean: 去掉@标记后的正文, unknown: [未匹配的标记...] }
   */
  function parseMentions(text) {
    const mentioned = [];
    const unknown = [];
    const seen = new Set();
    const clean = text
      .replace(/(^|\s)@([\p{L}\p{N}_-]+)/gu, (m, pre, token) => {
        const key = token.toLowerCase();
        const hit = ORDER.find((id) => aliases(id).has(key));
        if (hit) {
          if (!seen.has(hit)) {
            seen.add(hit);
            mentioned.push(hit);
          }
        } else {
          unknown.push(token);
        }
        return pre; // 保留 @ 前面的空白，只删掉 @标记
      })
      .replace(/[ \t]+/g, ' ')
      .trim();
    return { mentioned, clean, unknown };
  }

  /** 顶部在线状态条：在线绿色 / 离线灰色，点击名字可改名 */
  function renderAgents() {
    agentBar.innerHTML = '';
    for (const id of ORDER) {
      const meta = AGENT_META[id];
      const name = displayName(id);
      const online = !!(agents[id] && agents[id].online);
      const pill = document.createElement('div');
      pill.className = 'agent-pill' + (online ? ' online' : '');
      pill.title = online ? `${name} 在线，点击改名` : `${name} 离线（去打开它的标签页），点击改名`;
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.textContent = name;
      pill.appendChild(dot);
      pill.appendChild(label);
      pill.addEventListener('click', () => renameAgent(id));
      agentBar.appendChild(pill);
    }
  }

  /** 改名：prompt 输入，重名保护，持久化后刷新状态条与介绍 */
  function renameAgent(id) {
    const cur = displayName(id);
    const next = prompt(`给 ${AGENT_META[id].defaultName} 取个名字：`, cur);
    if (next === null) return; // 取消
    const name = next.trim();
    if (!name || name === cur) return;
    const dup = ORDER.some(
      (oid) => oid !== id && displayName(oid).toLowerCase() === name.toLowerCase()
    );
    if (dup) {
      addMessage({ kind: 'system', text: `名字「${name}」已经被用了，换一个吧。` });
      return;
    }
    if (name === AGENT_META[id].defaultName) {
      delete customNames[id];
    } else {
      customNames[id] = name;
    }
    chrome.storage.local.set({ [STORE_KEY]: customNames });
    renderAgents();
    refreshIntro();
    updateSendLabel();
  }

  /**
   * 追加一条消息。
   * kind: 'me'（我发出的） / 'status'（等待中） / 'response'（回答） / 'error'（出错） / 'system'（系统提示）
   * 传 html 时直接插入（调用方保证内容已转义），否则走 text 转义。
   */
  function addMessage({ agentId, kind, text, html }) {
    const wrap = document.createElement('div');
    const meta = agentId && AGENT_META[agentId];
    const body = html != null ? html : escapeHtml(text);
    if (kind === 'me') {
      wrap.className = 'msg me';
      wrap.innerHTML = `<div class="bubble"><div class="text">${body}</div></div>`;
    } else if (meta) {
      wrap.className = 'msg ' + kind;
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.style.background = meta.color;
      avatar.textContent = meta.letter;
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML =
        `<div class="agent-name">${escapeHtml(displayName(agentId))}</div>` +
        `<div class="text">${body}</div>`;
      wrap.appendChild(avatar);
      wrap.appendChild(bubble);
    } else {
      wrap.className = 'msg system';
      wrap.innerHTML = `<div class="bubble"><div class="text">${body}</div></div>`;
    }
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  /** 初始化介绍：强调每个人的名字与 @ 用法（每次打开侧边栏显示一次） */
  function introHtml() {
    const names = ORDER.map((id) => '@' + displayName(id)).join('　');
    return (
      `🤖 四位 AI 已就位：<b>${escapeHtml(names)}</b><br>` +
      `输入 <b>@名字</b> 只发给 TA；不加 @ 则群发给所有在线 AI。点击顶部名字可改名。`
    );
  }

  function showIntro() {
    introEl = addMessage({ kind: 'system', html: introHtml() });
  }

  function refreshIntro() {
    if (!introEl) return;
    const textEl = introEl.querySelector('.text');
    if (textEl) textEl.innerHTML = introHtml();
  }

  function onlineAgents() {
    return ORDER.filter((id) => agents[id] && agents[id].online);
  }

  /** 发送按钮文案：有 @提及 →「发送」，否则「群发」 */
  function sendLabel() {
    return parseMentions(promptEl.value).mentioned.length ? '发送' : '群发';
  }

  function updateSendLabel() {
    if (running === 0) sendBtn.textContent = sendLabel();
  }

  function updateButtons() {
    sendBtn.disabled = running > 0;
    sendBtn.textContent = running > 0 ? `生成中(${running})…` : sendLabel();
  }

  function doDispatch() {
    hidePopup();
    const raw = promptEl.value.trim();
    if (!raw) {
      promptEl.focus();
      return;
    }
    const { mentioned, clean, unknown } = parseMentions(raw);
    if (!clean) {
      addMessage({ kind: 'system', text: '只 @ 了名字、没有写内容。写点问题再发吧。' });
      return;
    }
    let targets;
    if (mentioned.length) {
      // @ 定向：只发给被 @ 且在线的 AI
      const online = mentioned.filter((id) => agents[id] && agents[id].online);
      const offline = mentioned.filter((id) => !(agents[id] && agents[id].online));
      if (offline.length) {
        addMessage({
          kind: 'system',
          text: `${offline.map(displayName).join('、')} 不在线，已跳过（去打开它的标签页）。`,
        });
      }
      if (unknown.length) {
        addMessage({ kind: 'system', text: `没认出 @${unknown.join('、@')}，已忽略。` });
      }
      if (!online.length) return;
      targets = online;
    } else {
      // 不加 @：群发给所有在线 AI
      targets = onlineAgents();
      if (!targets.length) {
        addMessage({ kind: 'system', text: '没有在线的 AI。请先登录各 AI 网页版，并各打开一个标签页。' });
        return;
      }
    }
    const taskId = 't' + Date.now();
    running += targets.length;
    updateButtons();
    addMessage({ kind: 'me', text: raw }); // 气泡里保留用户原本输入（含 @）
    promptEl.value = '';
    updateSendLabel();
    port.postMessage({ type: 'dispatch', taskId, agentIds: targets, prompt: clean });
  }

  function finishOneTask() {
    running = Math.max(0, running - 1);
    updateButtons();
  }

  // ---------- @ 自动补全 ----------

  let popupItems = []; // 当前候选的 agentId 列表
  let popupIndex = 0;

  /**
   * 检测光标前的 @提及输入：返回 { token, at }（at 是 @ 的下标），
   * @ 前面必须是开头或空白，否则返回 null。
   */
  function mentionQuery() {
    const pos = promptEl.selectionStart;
    const before = promptEl.value.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(before[at - 1])) return null;
    const token = before.slice(at + 1);
    if (!/^[\p{L}\p{N}_-]*$/u.test(token)) return null;
    return { token, at };
  }

  function updatePopup() {
    const q = mentionQuery();
    if (!q) {
      hidePopup();
      return;
    }
    const ql = q.token.toLowerCase();
    popupItems = ORDER.filter(
      (id) =>
        displayName(id).toLowerCase().includes(ql) ||
        AGENT_META[id].defaultName.toLowerCase().includes(ql)
    );
    if (!popupItems.length) {
      hidePopup();
      return;
    }
    popupIndex = 0;
    renderPopup();
  }

  function renderPopup() {
    popupEl.innerHTML = '';
    popupItems.forEach((id, i) => {
      const item = document.createElement('div');
      item.className = 'mention-item' + (i === popupIndex ? ' active' : '');
      const online = !!(agents[id] && agents[id].online);
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = online ? '#10b981' : '#d1d5db';
      const label = document.createElement('span');
      label.textContent = '@' + displayName(id) + (online ? '' : '（离线）');
      item.appendChild(dot);
      item.appendChild(label);
      // mousedown 而不是 click：blur 会先触发，用 mousedown 抢在前面
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickMention(id);
      });
      popupEl.appendChild(item);
    });
    popupEl.hidden = false;
  }

  function hidePopup() {
    popupEl.hidden = true;
    popupItems = [];
  }

  function pickMention(id) {
    const q = mentionQuery();
    if (!q) {
      hidePopup();
      return;
    }
    const pos = promptEl.selectionStart;
    const after = promptEl.value.slice(pos);
    const insert = '@' + displayName(id) + ' ';
    promptEl.value = promptEl.value.slice(0, q.at) + insert + after;
    const newPos = q.at + insert.length;
    promptEl.setSelectionRange(newPos, newPos);
    promptEl.focus();
    hidePopup();
    updateSendLabel();
  }

  // ---------- background 消息 ----------

  function handleBackgroundMessage(msg) {
    if (!msg || !msg.type) return;

    // 在线状态推送
    if (msg.type === 'agents') {
      agents = msg.agents || {};
      renderAgents();
      return;
    }

    // 派发开始：给每个目标 AI 一条"等待中"气泡，之后原地更新
    if (msg.type === 'dispatch_started') {
      for (const agentId of msg.agentIds || []) {
        const el = addMessage({ agentId, kind: 'status', text: `正在等待${displayName(agentId)}回答…` });
        pendingBubbles[msg.taskId + ':' + agentId] = el.querySelector('.text');
      }
      return;
    }

    // 生成中状态
    if (msg.type === 'task_status') {
      const textEl = pendingBubbles[msg.taskId + ':' + msg.agentId];
      if (textEl) textEl.textContent = `${displayName(msg.agentId)} 正在生成…`;
      return;
    }

    // 回答 / 出错：把等待气泡原地替换为最终内容
    if (msg.type === 'task_response' || msg.type === 'task_error') {
      finishOneTask();
      const key = msg.taskId + ':' + msg.agentId;
      const textEl = pendingBubbles[key];
      delete pendingBubbles[key];
      const wrap = textEl ? textEl.closest('.msg') : null;
      if (msg.type === 'task_response') {
        const text = msg.text || '(空回答：可能选择器失效，回答没抓到）';
        if (wrap) {
          wrap.className = 'msg response';
          textEl.textContent = text;
        } else {
          addMessage({ agentId: msg.agentId, kind: 'response', text });
        }
      } else {
        const text = '出错：' + msg.error;
        if (wrap) {
          wrap.className = 'msg error';
          textEl.textContent = text;
        } else {
          addMessage({ agentId: msg.agentId, kind: 'error', text });
        }
      }
      return;
    }

    if (msg.type === 'stopped') {
      addMessage({ kind: 'system', text: '已向所有在线 AI 发送停止指令。' });
    }
  }

  // ---------- 事件 ----------

  sendBtn.addEventListener('click', doDispatch);
  stopBtn.addEventListener('click', () => port.postMessage({ type: 'stop' }));
  promptEl.addEventListener('keydown', (e) => {
    // @ 补全弹窗打开时的键盘操作
    if (!popupEl.hidden && popupItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        popupIndex = (popupIndex + 1) % popupItems.length;
        renderPopup();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        popupIndex = (popupIndex - 1 + popupItems.length) % popupItems.length;
        renderPopup();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(popupItems[popupIndex]);
        return;
      }
      if (e.key === 'Escape') {
        hidePopup();
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doDispatch();
  });
  promptEl.addEventListener('input', () => {
    updatePopup();
    updateSendLabel();
  });
  promptEl.addEventListener('blur', () => setTimeout(hidePopup, 150));

  // ---------- 初始化 ----------

  renderAgents(); // 先按默认名画一版
  // 读出自定义名，刷新状态条，并强调每个人的名字
  chrome.storage.local.get(STORE_KEY, (res) => {
    customNames = (res && res[STORE_KEY]) || {};
    renderAgents();
    showIntro();
    updateSendLabel();
  });
})();
