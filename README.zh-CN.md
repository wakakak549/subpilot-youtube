# SubPilot · YouTube AI 双语字幕

**通过自己的 AI API 或本地 LM Studio 模型，自动翻译 YouTube 字幕。**

[English](README.md) | 简体中文

SubPilot 是一个 Chrome Manifest V3 扩展，读取 YouTube 已有字幕并随播放同步显示译文。可自行配置接口地址、密钥和模型，无需注册 SubPilot 账号或搭建额外后端。

当前版本：**0.1.6**。设置页和弹窗为简体中文，默认翻译成简体中文，可在设置中修改目标语言。

## 功能

- 双语、仅译文、仅原文三种显示模式，可调整字号，支持全屏。
- 支持 OpenAI Chat Completions 兼容接口，以及本地 LM Studio。
- 每次最多 **100 段字幕**，提前翻译范围可设为 **15–600 秒**。
- 本地译文缓存、有限重试、切换视频时取消旧任务，出错时恢复原生字幕。
- 为 Hy-MT2 使用专用提示词与输出校验，拦截合并长段落、编号缺失和提示词回显。
- 密钥保存在扩展本地存储，配置接口时按需申请对应 API 域名权限。

## 安装

需要桌面版 **Chrome 116 或更新版本**，以及本身有字幕的 YouTube 视频。

1. 在本仓库点击 **Code → Download ZIP** 并解压，也可以克隆：

   ```sh
   git clone https://github.com/wakakak549/subpilot-youtube.git
   ```

2. 在 Chrome 地址栏打开 `chrome://extensions/`，开启右上角的**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择仓库中的 **`extension/` 文件夹**。
4. 从 Chrome 扩展菜单打开 SubPilot，点击齿轮进入设置。
5. 填写 API 地址、密钥和准确的模型 ID，点击**保存配置**，允许访问对应接口域名，再点击**测试连接**。
6. 打开有字幕的 YouTube 视频并开启字幕。安装前已打开的视频页面需要刷新一次。

仓库中的 `extension/` 已包含可加载的文件，**普通使用无需安装 Node.js**。

更新时替换或拉取文件，在 `chrome://extensions/` 重新加载 SubPilot，再刷新 YouTube 页面。0.1.6 会淘汰旧译文缓存，保留 API 配置。

## API 配置

插件在 API 根地址后请求 **`/chat/completions`**，暂不支持只有 Responses API 的服务。模型 ID 必须由你的服务实际提供；预填名称不代表账号已有访问权限。

| 设置 | 默认值 / 行为 |
| --- | --- |
| API 地址 | `https://api.openai.com/v1` |
| 模型 | `gpt-6.1-sol`；请按服务实际提供的模型修改 |
| 接口类型 | 自动识别；本地回环地址使用兼容模式 |
| 目标语言 | 简体中文，可修改 |
| 严格 JSON 输出 | 开启；服务不支持 JSON Schema 时关闭 |
| 推理强度 | 低；云端服务不支持该参数时选择“自动” |
| 响应超时 | 120 秒，可设 15–300 秒 |
| 每次翻译段数 | 6 段，可设 1–100 段 |
| 预取时长 | 45 秒，可设 15–600 秒 |

使用远程第三方兼容接口时，在**接口兼容设置**中选择 **LM Studio / 兼容接口**，插件将使用 `max_tokens` 并省略 OpenAI 专用推理参数。使用需要 OpenAI 参数的本地代理时，可明确选择 **OpenAI**。

“每次翻译段数”是单次请求的上限，实际段数取决于播放位置、预取范围和已有缓存。可以先试 30 段、180 秒，再按模型表现增加；批次越大，等待时间和格式异常的概率也可能增加。

连接测试和字幕翻译都会真实调用你配置的 API，费用由接口服务方计算。插件不提供 API 额度，也不会复用 ChatGPT 或 Codex 的登录凭据。

### LM Studio

1. 在 LM Studio 中加载文本模型，并启动本地服务。
2. API 地址填写 **`http://localhost:1234/v1`**。只填 `http://localhost:1234`、`http://127.0.0.1:1234` 等回环地址时，插件会自动补 `/v1`。
3. 点击模型输入框旁的刷新按钮，获取服务提供的模型 ID，优先选择**已经加载**的模型，并填写准确名称。
4. 未启用服务鉴权时，密钥留空；已启用时填写服务令牌。保存后测试连接。

通过局域网访问 LM Studio 时，请明确选择兼容接口类型，并确保浏览器能访问该服务。模型响应较慢时可以增加超时。

### Hy-MT2

插件识别包含受支持 `hy-mt2` 标识的模型 ID 后，会自动采用纯文本翻译提示与[模型卡](https://huggingface.co/tencent/Hy-MT2-7B-GGUF)推荐的采样参数，不发送 system 消息或严格 JSON Schema。请填写服务实际提供的模型 ID；不含该标识的自定义别名不会启用专用处理。

Hy-MT2 批次只发送本批待译字幕。编号或条数不完整时，整个批次改为逐条重译，避免模型合并前几条后把后续编号整体前移。明显过长的译文和提示词回显会在显示、缓存前被拒收。这种补救会增加请求数和等待时间，格式校验也不能保证语义准确。

## 隐私与权限

- 待翻译字幕、通用模型需要的邻近上下文及翻译指令会发送到**你配置的 API 地址**；Hy-MT2 不附带额外上下文。
- 密钥、配置、译文使用 `chrome.storage.local`，不写入 Chrome 同步存储。本地存储只允许可信扩展上下文访问，内容脚本收到的配置不含密钥。本地存储并非专用的加密密钥库。
- 扩展固定访问 `www.youtube.com`，保存或测试接口时按需申请对应 API 域名权限。
- 项目没有自己的统计服务、账号系统或翻译中转服务。接口服务方仍会按其自身的数据政策处理请求。

## 使用范围与限制

本版面向桌面 YouTube **`/watch?v=...`** 录播视频，需要有人工或自动字幕。源字幕语言跟随 YouTube 播放器当前选择的字幕轨。

暂不包括无字幕视频的语音识别、直播、Shorts、嵌入播放器和画中画字幕。本项目通过加载已解压扩展安装，尚未上架 Chrome 应用商店。YouTube 字幕的访问条件可能随会话变化；无法读取时，插件会报告失败并保留原生字幕显示。

## 开发

使用 **Node.js 22 或更新版本**：

```sh
npm ci
npm run build
npm test
npm run test:browser
```

Windows PowerShell 若因执行策略无法运行 `npm.ps1`，请使用 `npm.cmd`。

构建步骤打包本地 Lucide 图标并检查扩展资源。浏览器测试使用独立配置和模拟翻译服务：Windows 下优先使用已安装 Chrome，其他环境使用 Playwright Chromium（`npx playwright install chromium`）。可通过 `YTAI_BROWSER_PATH` 指定浏览器程序，不会修改日常 Chrome 配置。

可选检查：

```sh
# 真实 YouTube 页面，翻译 API 使用模拟服务
node tests/youtube-smoke.mjs

# 真实调用已经加载的本地 LM Studio 模型
node tests/lmstudio-smoke.mjs
```

YouTube 检查脚本默认使用 Windows 标准 Chrome 路径，其他系统请设置 `YTAI_BROWSER_PATH`。LM Studio 检查只连接回环地址，不加载或切换模型。

当前回归套件包含 **50 项核心测试、24 项浏览器集成检查**。已测范围与真实视频验收限制见[验证记录](docs/verification.md)，相关问题见[字幕合并排查记录](docs/bugs/merged-subtitles.md)。测试生成的 `.cache/` 浏览器配置与 `artifacts/` 截图、接口诊断文件不上传 Git。

## 参与贡献

欢迎提交 Issue 和 Pull Request。报告问题时请附扩展版本、浏览器版本、接口类型、模型 ID 和复现步骤。分享日志前请去掉 API 密钥、私有地址及个人字幕数据。

## 许可与致谢

使用 [MIT 许可](LICENSE)。架构、部分字幕分组和覆盖层行为、扩展图标参考并改造自 [MoJo-Spy/youtube-bilingual-subs](https://github.com/MoJo-Spy/youtube-bilingual-subs)，保留原版权与 MIT 声明。界面图标使用 [Lucide](https://lucide.dev/)，遵循 ISC 许可。

详见[第三方声明](extension/THIRD_PARTY_NOTICES.md)及[Lucide 许可](extension/vendor/lucide.LICENSE)。
