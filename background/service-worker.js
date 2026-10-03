/* 多智能体编排中枢（MV3 Service Worker，事件驱动）
 *
 * 职责：
 * 1. Tab 发现：按四个 AI 域名匹配标签页，维护在线 Agent 列表
 * 2. 状态推送：tabs 变化时实时把在线状态推给侧边栏
 * 3. 消息路由：侧边栏 dispatch → 对应 tab 的 content script；
 *    content script 回传的 status/response/error → 转给侧边栏
 * 4. 单任务超时熔断：3 分钟未完成则标记失败
 *
 * 注意：MV3 Service Worker 是事件驱动的，长时间无事件会被浏览器回收，
 * setTimeout 熔断是尽力而为（MVP 可接受，长期可用 chrome.alarms 替代）。
 */
'use strict';

// 四个 AI 的域名配置（与 manifest 的 matches 保持一致）
const AGENTS = [
  { id: 'chatgpt', name: 'ChatGPT', domains: ['chatgpt.com', 'chat.openai.com'] },
  { id: 'claude', name: 'Claude', domains: ['claude.ai'] },
  { id: 'gemini', name: 'Gemini', domains: ['gemini.google.com'] },
  { id: 'deepseek', name: 'DeepSeek', domains: ['chat.deepseek.com'] },
];

const TASK_TIMEOUT_MS = 3 * 60 * 1000; // 单任务 3 分钟熔断

let agents = {}; // agentId -> { tabId, title }，每个 AI 只取第一个匹配的标签页
const ports = new Set(); // 侧边栏长连接
const pendingTasks = new Map(); // `${taskId}:${agentId}` -> timeoutId

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

function matchAgent(url) {
  const host = hostOf(url);
  if (!host) return null;
  return AGENTS.find((a) => a.domains.some((d) => host === d || host.endsWith('.' + d))) || null;
}

/** 扫描所有标签页，刷新在线 Agent 列表并推送给侧边栏 */
async function refreshAgents() {
  const tabs = await chrome.tabs.query({});
  const next = {};
  for (const tab of tabs) {
    if (!tab.url) continue;
    const agent = matchAgent(tab.url);
    if (agent && !next[agent.id]) {
      next[agent.id] = { tabId: tab.id, title: tab.title || '' };
    }
  }
  agents = next;
  broadcast({ type: 'agents', agents: agentStatus() });
}

function agentStatus() {
  const out = {};
  for (const a of AGENTS) {
    out[a.id] = {
      name: a.name,
      online: !!agents[a.id],
      tabId: agents[a.id] ? agents[a.id].tabId : null,
    };
  }
  return out;
}

function broadcast(msg) {
  for (const p of ports) {
    try {
      p.postMessage(msg);
    } catch (e) {
      /* 连接已断开，onDisconnect 会清理 */
    }
  }
}

// ---- 生命周期 ----
chrome.runtime.onInstalled.addListener(() => {
  // 点插件图标直接打开侧边栏
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  refreshAgents();
});
chrome.runtime.onStartup.addListener(() => refreshAgents());

// ---- Tab 变化监听 ----
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' || info.url) refreshAgents();
});
chrome.tabs.onRemoved.addListener(() => refreshAgents());

// ---- 侧边栏长连接 ----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  ports.add(port);
  // 新连接先推一次当前状态
  refreshAgents();
  port.onMessage.addListener((msg) => handlePanelMessage(msg, port));
  port.onDisconnect.addListener(() => ports.delete(port));
});

function handlePanelMessage(msg, port) {
  // 群发任务：{ type:'dispatch', taskId, agentIds[], prompt }
  if (msg.type === 'dispatch') {
    const taskId = msg.taskId || 't' + Date.now();
    const targets = (msg.agentIds || []).filter((id) => agents[id]);
    if (!targets.length) {
      port.postMessage({ type: 'task_error', taskId, error: '没有在线的 AI 标签页' });
      return;
    }
    for (const agentId of targets) {
      const key = taskId + ':' + agentId;
      // 超时熔断
      const timer = setTimeout(() => {
        pendingTasks.delete(key);
        broadcast({ type: 'task_error', taskId, agentId, error: '任务超时（3 分钟未返回）' });
      }, TASK_TIMEOUT_MS);
      pendingTasks.set(key, timer);
      // 向对应 tab 的 content script 派发任务
      chrome.tabs
        .sendMessage(agents[agentId].tabId, { type: 'miao_task', taskId, agentId, prompt: msg.prompt })
        .catch((err) => {
          clearTimeout(timer);
          pendingTasks.delete(key);
          broadcast({ type: 'task_error', taskId, agentId, error: '无法连接标签页：' + err.message });
        });
    }
    port.postMessage({ type: 'dispatch_started', taskId, agentIds: targets });
    return;
  }

  // 停止：向所有在线 AI 的 tab 发停止指令
  if (msg.type === 'stop') {
    for (const id of Object.keys(agents)) {
      chrome.tabs.sendMessage(agents[id].tabId, { type: 'miao_stop' }).catch(() => {});
    }
    broadcast({ type: 'stopped' });
  }
}

// ---- content script 回传 ----
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'miao_status') {
    broadcast({ type: 'task_status', taskId: msg.taskId, agentId: msg.agentId, status: msg.status });
    return;
  }
  if (msg.type === 'miao_response' || msg.type === 'miao_error') {
    // 任务结束，清除熔断计时器
    const key = msg.taskId + ':' + msg.agentId;
    const timer = pendingTasks.get(key);
    if (timer) {
      clearTimeout(timer);
      pendingTasks.delete(key);
    }
    broadcast(
      msg.type === 'miao_response'
        ? { type: 'task_response', taskId: msg.taskId, agentId: msg.agentId, text: msg.text }
        : { type: 'task_error', taskId: msg.taskId, agentId: msg.agentId, error: msg.error }
    );
  }
});
