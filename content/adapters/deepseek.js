/* DeepSeek 网页版适配器（https://chat.deepseek.com）
 *
 * ===== 选择器集中在此，官网改版导致失效时优先来这里修 =====
 * 思考链与正文分离：只取正文渲染区（.ds-markdown），排除思考链容器。
 */
(function () {
  'use strict';

  const SEL = {
    input: ['textarea#chat-input'], // 输入框（原生 textarea）
    send: ['button[type="submit"]'], // 发送按钮
    stop: ['button[aria-label*="停止" i]', 'button[aria-label*="Stop" i]'], // 停止按钮
  };

  function mustFindInput() {
    const el = window.MIAO.queryFirst(SEL.input);
    if (!el) throw new Error('找不到 DeepSeek 输入框（选择器可能已失效）');
    return el;
  }

  window.MIAO.registerAdapter('deepseek', {
    async setInputText(text) {
      await window.MIAO.typeText(mustFindInput(), text);
    },

    async clickSend() {
      const btn = window.MIAO.queryFirst(SEL.send);
      if (btn && !btn.disabled) {
        btn.click();
        return;
      }
      // 兜底：DeepSeek 输入框回车即发送
      const input = mustFindInput();
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
    },

    isGenerating() {
      // 生成中时发送按钮会变成"停止"按钮
      if (window.MIAO.queryFirst(SEL.stop)) return true;
      // 兜底：输入框被禁用通常也在生成中
      const input = window.MIAO.queryFirst(SEL.input);
      return !!(input && input.disabled);
    },

    async getLastResponse() {
      // 只取正文渲染区，排除思考链容器
      const nodes = [...document.querySelectorAll('.ds-markdown')].filter(
        (el) => !el.closest('.ds-think, [class*="think"]')
      );
      for (let i = nodes.length - 1; i >= 0; i--) {
        const t = (nodes[i].innerText || '').trim();
        if (t) return t;
      }
      return window.MIAO.lastTextBlock();
    },

    async stopGeneration() {
      const btn = window.MIAO.queryFirst(SEL.stop);
      if (btn) btn.click();
    },
  });
})();
