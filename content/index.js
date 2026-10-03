/* 内容脚本入口：按当前页面 hostname 路由到对应的 adapter，
 * 并监听来自 background 的任务消息（派发 / 停止），把执行结果回传。
 *
 * 注意：所有 adapter 文件（base.js + 四个 adapter）都已在 manifest 的
 * content_scripts 中先于本文件注入，直接取 window.MIAO.adapters 即可。
 */
(function () {
  'use strict';

  // hostname → adapter id 路由表
  const ROUTES = [
    { id: 'chatgpt', hosts: ['chatgpt.com', 'chat.openai.com'] },
    { id: 'claude', hosts: ['claude.ai'] },
    { id: 'gemini', hosts: ['gemini.google.com'] },
    { id: 'deepseek', hosts: ['chat.deepseek.com'] },
  ];

  const host = location.hostname;
  const route = ROUTES.find((r) => r.hosts.some((h) => host === h || host.endsWith('.' + h)));
  if (!route) return; // 非 AI 站点，不做任何事

  const adapter = window.MIAO && window.MIAO.adapters && window.MIAO.adapters[route.id];
  if (!adapter) {
    console.warn('[MIAO] 未找到 adapter，已跳过:', route.id);
    return;
  }
  console.log('[MIAO] adapter 就绪:', route.id);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'miao_task') {
      handleTask(msg); // 异步执行，不阻塞消息通道
      return false;
    }
    if (msg.type === 'miao_stop') {
      Promise.resolve()
        .then(() => adapter.stopGeneration())
        .catch((e) => console.warn('[MIAO] 停止失败:', e));
      return false;
    }
  });

  async function handleTask({ taskId, prompt }) {
    const post = (m) => {
      try {
        chrome.runtime.sendMessage(m).catch(() => {});
      } catch (e) {
        /* Service Worker 休眠等情况，忽略 */
      }
    };
    post({ type: 'miao_status', agentId: route.id, taskId, status: 'running' });
    try {
      const text = await window.MIAO.runTask(adapter, prompt);
      post({ type: 'miao_response', agentId: route.id, taskId, text });
    } catch (err) {
      post({
        type: 'miao_error',
        agentId: route.id,
        taskId,
        error: String((err && err.message) || err),
      });
    }
  }
})();
