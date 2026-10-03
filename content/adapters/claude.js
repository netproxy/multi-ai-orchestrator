/* Claude 网页版适配器（https://claude.ai）
 *
 * ===== 选择器集中在此，官网改版导致失效时优先来这里修 =====
 * 注意：Claude 输入框是 ProseMirror 富文本，必须用 beforeinput / execCommand 方式输入，
 * 直接改 innerText 不会同步到编辑器状态（base.js 的打字模拟器已处理）。
 */
(function () {
  'use strict';

  const SEL = {
    input: ['div.ProseMirror[contenteditable="true"]'], // ProseMirror 输入框
    send: ['button[aria-label*="Send" i]'], // 发送按钮（ARIA 语义优先）
    stop: ['button[aria-label*="Stop" i]'], // 停止按钮：存在 = 正在生成
    // Claude 官方 DOM 没有长期稳定的回答容器选择器，暂留空走通用兜底；
    // 若发现稳定的选择器，填到这里即可（extractLastResponse 会优先使用）。
    response: [],
  };

  function mustFindInput() {
    const el = window.MIAO.queryFirst(SEL.input);
    if (!el) throw new Error('找不到 Claude 输入框（选择器可能已失效）');
    return el;
  }

  window.MIAO.registerAdapter('claude', {
    async setInputText(text) {
      await window.MIAO.typeText(mustFindInput(), text);
    },

    async clickSend() {
      const btn = window.MIAO.queryFirst(SEL.send);
      if (!btn) throw new Error('找不到 Claude 发送按钮（选择器可能已失效）');
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
