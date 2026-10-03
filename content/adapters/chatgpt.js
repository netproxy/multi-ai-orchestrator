/* ChatGPT 网页版适配器（https://chatgpt.com / https://chat.openai.com）
 *
 * ===== 选择器集中在此，官网改版导致失效时优先来这里修 =====
 * 优先使用 ARIA / data-testid 这类语义属性，类名只做备用。
 */
(function () {
  'use strict';

  const SEL = {
    input: ['#prompt-textarea'], // 输入框（contenteditable）
    send: ['button[data-testid="send-button"]'], // 发送按钮
    stop: ['button[data-testid="stop-button"]'], // 停止按钮：存在 = 正在生成
    response: ['[data-message-author-role="assistant"]'], // assistant 消息容器
  };

  function mustFindInput() {
    const el = window.MIAO.queryFirst(SEL.input);
    if (!el) throw new Error('找不到 ChatGPT 输入框（选择器可能已失效）');
    return el;
  }

  window.MIAO.registerAdapter('chatgpt', {
    async setInputText(text) {
      await window.MIAO.typeText(mustFindInput(), text);
    },

    async clickSend() {
      const btn = window.MIAO.queryFirst(SEL.send);
      if (!btn) throw new Error('找不到 ChatGPT 发送按钮（选择器可能已失效）');
      btn.click();
    },

    isGenerating() {
      return !!window.MIAO.queryFirst(SEL.stop);
    },

    async getLastResponse() {
      return window.MIAO.extractLastResponse(SEL.response);
    },

    async stopGeneration() {
      const btn = window.MIAO.queryFirst(SEL.stop);
      if (btn) btn.click();
    },
  });
})();
