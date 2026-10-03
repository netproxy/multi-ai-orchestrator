/* 多智能体浏览器协同 · Adapter 公共基础库
 *
 * 职责：
 * 1. 定义各 adapter 必须实现的统一接口：
 *    setInputText(text) / clickSend() / isGenerating() / getLastResponse() / stopGeneration()
 * 2. 提供公共工具：打字模拟器、轮询等待、回答提取与兜底
 *
 * 注意：content script 运行在页面的隔离环境（isolated world）中，
 * base.js 与各 adapter、index.js 共享同一个 window.MIAO 命名空间。
 */
(function () {
  'use strict';

  const MIAO = (window.MIAO = window.MIAO || {});
  MIAO.adapters = MIAO.adapters || {};

  /** 注册一个 adapter：MIAO.registerAdapter('chatgpt', { setInputText, ... }) */
  MIAO.registerAdapter = function (id, impl) {
    const required = ['setInputText', 'clickSend', 'isGenerating', 'getLastResponse', 'stopGeneration'];
    for (const k of required) {
      if (typeof impl[k] !== 'function') {
        console.error(`[MIAO] adapter "${id}" 缺少接口方法: ${k}，已跳过注册`);
        return;
      }
    }
    MIAO.adapters[id] = impl;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  MIAO.sleep = sleep;

  /** 按选择器列表依次查找，返回第一个命中的元素（选择器非法时跳过） */
  MIAO.queryFirst = function (selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* 忽略非法选择器 */
      }
    }
    return null;
  };

  /**
   * 打字模拟器：把文本按 20~50 字符分块输入，每块之间 10~30ms 随机延迟。
   * - 富文本框（contenteditable）：优先 document.execCommand('insertText')，
   *   降级为派发 beforeinput 事件（让 ProseMirror 这类编辑器自己处理），再兜底手动插入文本节点。
   * - textarea / input：用原型上的原生 value setter（绕过 React 的值追踪），再派发 input 事件。
   */
  MIAO.typeText = async function (el, text) {
    el.focus();
    moveCursorToEnd(el);

    let i = 0;
    while (i < text.length) {
      const chunkLen = 20 + Math.floor(Math.random() * 31); // 20~50
      const chunk = text.slice(i, i + chunkLen);
      i += chunkLen;
      insertChunk(el, chunk);
      await sleep(10 + Math.random() * 20); // 10~30ms
    }
    // 收尾再派发一次 input，确保框架状态同步
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  function moveCursorToEnd(el) {
    try {
      if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (typeof el.selectionStart === 'number') {
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  function insertChunk(el, chunk) {
    if (el.isContentEditable) {
      // 方案 A：execCommand，兼容性最好
      try {
        if (document.execCommand('insertText', false, chunk)) return;
      } catch (e) {
        /* 继续降级 */
      }
      // 方案 B：派发 beforeinput，让编辑器自己处理（如 ProseMirror）
      const before = el.textContent.length;
      el.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: chunk,
          bubbles: true,
          cancelable: true,
        })
      );
      // 方案 C：编辑器没处理（文本没变化），手动插入文本节点兜底
      if (el.textContent.length === before) insertTextNodeAtCursor(chunk);
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: chunk, bubbles: true }));
    } else {
      // textarea / input：原生 setter + input 事件
      try {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        setter.call(el, el.value.slice(0, start) + chunk + el.value.slice(end));
        el.selectionStart = el.selectionEnd = start + chunk.length;
      } catch (e) {
        el.value = (el.value || '') + chunk; // 最后兜底
      }
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: chunk, bubbles: true }));
    }
  }

  function insertTextNodeAtCursor(chunk) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(chunk);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** 轮询等待，直到 fn() 返回真值或超时（默认 30 秒） */
  MIAO.waitFor = async function (fn, { timeout = 30000, interval = 500 } = {}) {
    const start = Date.now();
    for (;;) {
      let v = null;
      try {
        v = fn();
      } catch (e) {
        /* 选择器异常时继续等 */
      }
      if (v) return v;
      if (Date.now() - start >= timeout) throw new Error('等待超时');
      await sleep(interval);
    }
  };

  /**
   * 跑完一次完整任务：输入 → 发送 → 等待生成结束 → 提取回答。
   * 生成结束判定：isGenerating() 由 true 变 false 后，再稳定 stableMs（默认 1.5 秒）。
   */
  MIAO.runTask = async function (adapter, prompt, { timeout = 180000, stableMs = 1500 } = {}) {
    await adapter.setInputText(prompt);
    await sleep(400); // 给输入框一点渲染时间
    await adapter.clickSend();

    // 等待进入"生成中"（短回答可能来不及捕捉，捕捉不到就直接往下走）
    try {
      await MIAO.waitFor(() => adapter.isGenerating(), { timeout: 15000, interval: 300 });
    } catch (e) {
      /* 忽略 */
    }

    // 等待生成结束
    const start = Date.now();
    for (;;) {
      let generating = false;
      try {
        generating = adapter.isGenerating();
      } catch (e) {
        /* 忽略 */
      }
      if (!generating) {
        await sleep(stableMs);
        try {
          generating = adapter.isGenerating();
        } catch (e) {
          generating = false;
        }
        if (!generating) break;
      }
      if (Date.now() - start >= timeout) throw new Error('任务超时（3 分钟未完成）');
      await sleep(500);
    }

    return adapter.getLastResponse();
  };

  /**
   * 提取最后一条回答：按专用选择器从后往前找第一个非空文本；
   * 都找不到时用通用兜底（main 区域最后一个长文本块）。
   */
  MIAO.extractLastResponse = function (selectors) {
    for (const sel of selectors || []) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (let i = nodes.length - 1; i >= 0; i--) {
        const t = (nodes[i].innerText || '').trim();
        if (t) return t;
      }
    }
    return MIAO.lastTextBlock();
  };

  /** 通用兜底：main（或 body）里最后一个"像回答"的长文本块（启发式，仅兜底） */
  MIAO.lastTextBlock = function (minLen = 80) {
    const root = document.querySelector('main') || document.body;
    const els = root.querySelectorAll('div, article, section');
    let best = '';
    for (const el of els) {
      // 跳过包含输入框的容器，避免把用户自己的输入当成回答
      if (el.querySelector('textarea, input, [contenteditable="true"]')) continue;
      const t = (el.innerText || '').trim();
      if (t.length >= minLen) best = t; // 文档顺序靠后的覆盖，最终得到最后一个
    }
    return best;
  };
})();
