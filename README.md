# 多智能体浏览器协同 (Multi-AI Browser Orchestrator) · MVP

Chrome MV3 扩展骨架：**零构建步骤**，纯 HTML / CSS / JS。
在浏览器侧边栏里一句话群发 ChatGPT / Claude / Gemini / DeepSeek 四个网页版 AI，对比它们的回答。

## 加载方法

1. 打开 `chrome://extensions`
2. 右上角打开**开发者模式**
3. 点击**加载未打包的扩展程序**，选择本目录 `multi-ai-orchestrator/`
4. 点击浏览器工具栏的插件图标，侧边栏会自动打开（已配置 `openPanelOnActionClick`）

## 使用流程

1. **先登录**：在 Chrome 里分别登录 ChatGPT、Claude、Gemini、DeepSeek 的网页版，**每家各打开一个标签页**（保持登录态）。
2. **开侧边栏**：点插件图标，顶部状态条里在线的 AI 会显示绿色。
3. **群发**：底部输入框写问题，点"群发"（或 Ctrl+Enter），问题会同时发给所有在线的 AI。
4. **看回答**：每个 AI 的回答以"头像 + 气泡"形式出现在消息流里；等不及可点"停止"。

## 目录结构

```
multi-ai-orchestrator/
├── manifest.json                  # MV3 配置
├── background/service-worker.js   # Tab 发现、消息路由、3 分钟超时熔断
├── content/adapters/base.js       # 统一接口契约 + 打字模拟器 + 等待/提取工具
├── content/adapters/chatgpt.js    # ChatGPT 适配器
├── content/adapters/claude.js     # Claude 适配器
├── content/adapters/gemini.js     # Gemini 适配器
├── content/adapters/deepseek.js   # DeepSeek 适配器（思考链与正文分离）
├── content/index.js               # 按 hostname 路由到 adapter，收发任务消息
├── sidepanel/                     # 侧边栏 UI（状态条 / 消息流 / 输入区）
└── README.md
```

## 工作原理（MVP 范围）

- **派发**：侧边栏 → background（长连接）→ 对应 tab 的 content script → adapter 打字输入 → 点发送。
- **收回答**：adapter 轮询 `isGenerating()`，由 true 变 false 后再稳定 1.5 秒，判定生成结束，提取最后一条回答 → 回传侧边栏展示。
- **打字模拟**：20~50 字符分块、每块 10~30ms 随机延迟；富文本框优先 `execCommand('insertText')`，降级派发 `beforeinput`；textarea 用原生 value setter 绕过 React 状态追踪。

## 已知限制

1. **选择器可能随官网改版失效**：这是最大的维护点。各 adapter 的选择器集中在文件顶部 `SEL` 常量，失效时优先去那里修；回答提取有通用兜底（main 区域最后一个长文本块），但抓到的可能不准。
2. **需要用户已登录各 AI 账号**：插件不处理登录，你必须事先在对应标签页里登录好。
3. **自动化操作需自行评估 ToS 风险**：程序化打字、自动点击发送可能触发各家的机器人检测，甚至违反其服务条款；请自行评估，玩玩可以，别搞大并发。
4. **MV3 Service Worker 会被回收**：长时间无事件时浏览器会挂起 SW，3 分钟熔断用的 `setTimeout` 是尽力而为；MVP 阶段可接受，长期可用 `chrome.alarms` 替代。
5. **网页版也有额度**：各家订阅都有消息条数限制，群发烧额度很快，注意别把自己号玩封了。
6. **单标签页假设**：同一 AI 开多个标签页时，只用第一个匹配到的。

## 新功能：起名 + @定向发送

- **改名**：点击顶部状态条里的名字，输入新名字即可（存在浏览器本地，改名后 @ 时用新名字；重名会被拒绝）。
- **@定向**：输入框里打 `@` 会弹出候选列表（上下键选择、回车/Tab 选中，或直接点），`@名字` 只把消息发给 TA。支持多个 `@`（如 `@Claude @GPT 一起看看这段代码`）。改名后旧名和英文 id 仍可作为别名 @。
- **群发**：不加 `@` 直接发送，就是群发给所有在线 AI。
- **初始化介绍**：每次打开侧边栏，消息流顶部会先列出四个 AI 的名字和 @ 用法。
- 发送按钮会跟着输入变化：检测到 @提及 显示"发送"，否则显示"群发"。
- @ 进邮箱地址不算提及（@ 前面必须是开头或空白）；@ 了离线或不存在的名字会收到系统提示。
