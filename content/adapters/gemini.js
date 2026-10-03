/* Gemini 网页版适配器（https://gemini.google.com）
 *
 * ===== 选择器集中在此，官网改版导致失效时优先来这里修 =====
 */
(function () {
  'use strict';

  const SEL = {
    input: ['rich-textarea div[contenteditable="true"]'], // 输入框在 rich-textarea 内
    send: [
      'button[aria-label*="Send message" i]',
      'button[aria-label*="Send" i]',
      '.send-button', // 类名备用
    ],
    stop: [
      'button[aria-label*="Stop" i]',
      '.stop-button', // 类名备用
    ], // 停止按钮：存在 = 正在生成
    response: ['message-content', '.response-container .markdown'],
  };

  function mustFindInput() {
    const el = window.MIAO.queryFirst(SEL.input);
    if (!el) throw new Error('找不到 Gemini 输入框（选择器可能已失效）');
    return el;
  }

  window.MIAO.registerAdapter('gemini', {
    async setInputText(text) {
      await window.MIAO.typeText(mustFindInput(), text);
    },

    async clickSend() {
      const btn = window.MIAO.queryFirst(SEL.send);
      if (!btn) throw new Error('找不到 Gemini 发送按钮（选择器可能已失效）');
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
