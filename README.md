# SubPilot

**Translate YouTube captions with your own AI API or a local LM Studio model.**

English | [简体中文](README.zh-CN.md)

SubPilot is a Chrome Manifest V3 extension that translates existing YouTube captions and displays them in sync with playback. Bring your own API endpoint, key, and model; no SubPilot account or backend is required.

Current version: **0.1.9**. The settings and popup are currently in Simplified Chinese. The default translation language is Simplified Chinese and can be changed in settings.

## Features

- Bilingual, translation-only, and original-only display, with adjustable font sizes and fullscreen support.
- OpenAI Chat Completions-compatible APIs, including local LM Studio servers.
- Up to **100 subtitle segments per request**, with a configurable **15–600 second** look-ahead window.
- Video-title and adjacent-caption context enabled by default. Hy-MT2 uses batches of up to **8 segments**, displayed individually on their original timestamps.
- Local translation cache, bounded retries, cancellation on video changes, and native-caption fallback on errors.
- Dedicated Hy-MT2 prompts and output validation to reject merged paragraphs, missing IDs, and echoed instructions.
- Simplified and Traditional Chinese caption tracks stay as native YouTube subtitles and never call the translation API.
- API keys stored in local extension storage; access to your API host is requested when you configure it.

## Install

Requires desktop **Chrome 116+** and a YouTube video with existing captions.

1. Download this repository using **Code → Download ZIP**, then extract it, or clone it:

   ```sh
   git clone https://github.com/wakakak549/subpilot-youtube.git
   ```

2. Open `chrome://extensions/` and enable **Developer mode**.
3. Choose **Load unpacked** and select the repository's **`extension/`** folder.
4. Open SubPilot from Chrome's extension menu, then click the gear button to open settings.
5. Enter your API base URL, key, and exact model ID. Click **保存配置** (Save), grant access to the API host, then click **测试连接** (Test connection).
6. Open a captioned YouTube video and enable its captions. Refresh YouTube tabs that were open before installation.

The checked-in `extension/` folder is ready to load. **Node.js is only needed for development.**

To update an unpacked installation, replace or pull the files, reload SubPilot on `chrome://extensions/`, then refresh YouTube. Version 0.1.9 keeps your API settings and the translation cache from 0.1.8.

## Configure your API

SubPilot sends requests to **`/chat/completions`** under the base URL. Responses API-only services are not supported. Use a model ID actually served by your provider.

The model-specific prompt, sampling, and output validation documented here are optimized for **Hy-MT2**. This README makes no quality or compatibility claim for any particular cloud model.

| Setting | Default / behavior |
| --- | --- |
| API base URL | `https://api.openai.com/v1` |
| Model | Your provider's exact model ID |
| API format | Automatic; loopback URLs use compatibility mode |
| Target language | Simplified Chinese; editable |
| Strict JSON output | Enabled; disable if your service lacks JSON Schema support |
| Reasoning effort | Low; choose Auto if your cloud service rejects the parameter |
| Request timeout | 120 seconds; configurable from 15 to 300 |
| Batch size | 6 segments; configurable from 1 to 100 |
| Look-ahead | 45 seconds; configurable from 15 to 600 |
| Title and caption context | Enabled; video title and up to 3 captions before and after each batch |

For a remote third-party compatible endpoint, choose **LM Studio / 兼容接口** under **接口兼容设置**. This uses `max_tokens` and omits OpenAI-specific reasoning parameters. For a local proxy that expects OpenAI parameters, explicitly choose **OpenAI**.

The batch size is an upper bound. The current playback position, look-ahead window, and cache determine how many segments are sent. With context enabled, Hy-MT2 uses at most 8 segments per request; smaller configured batches stay smaller. Disabling **结合标题与前后字幕翻译** (Use title and caption context) restores the configured limit of up to 100. Larger batches can increase latency and output-format failures.

For Hy-MT2 context mode, the look-ahead setting triggers the next group rather than cutting it off mid-batch. A group may extend up to **30 seconds beyond** that boundary, which prevents steady playback from requesting each newly entering caption separately. A subtitle inside the normal window must be missing before another group starts. Current missing captions are handled immediately; sparse captions, the end of a video, cache hits, and error recovery can still produce smaller requests.

API usage, including the connection test, is handled and billed by your configured provider. SubPilot does not include API credit or reuse a ChatGPT/Codex login.

### LM Studio

1. Load a text model and start LM Studio's local server.
2. Enter **`http://localhost:1234/v1`** as the base URL. Bare loopback URLs such as `http://localhost:1234` or `http://127.0.0.1:1234` are also normalized to `/v1`.
3. Click the refresh button next to the model field to fetch model IDs. Select an **already loaded** model using its exact ID.
4. Leave the key empty if server authentication is disabled; otherwise enter the server token. Save and test the connection.

For a LAN-hosted LM Studio server, choose compatibility mode explicitly and make sure the server is reachable from your browser. Increase the timeout for slower models.

### Hy-MT2

Model IDs containing the supported `hy-mt2` marker automatically use a plain-text translation prompt instead of system messages or JSON Schema, with the sampling settings recommended by the [Hy-MT2 model card](https://huggingface.co/tencent/Hy-MT2-7B-GGUF). Use the model ID supplied by your server; a custom alias without this marker will not activate the special handling.

Context mode follows the model card's background/source template: the video title and up to 3 preceding and following captions help interpret a small group of subtitles. Only the requested subtitles should be translated. They keep their IDs and original timestamps, so playback still shows one subtitle at a time. Context is supplied with each request; there is no full-video summary or persistent model conversation.

Incomplete or reset numbering in a contextual batch triggers individual retranslations of the entire batch, because later IDs may have shifted after the model merged earlier lines. Clearly oversized translations, copied reference text, and echoed instructions are rejected before display or caching. Recovery requests omit context and use a simple single-subtitle prompt. Titles, surrounding captions, and the context setting are included in cache keys. This recovery adds requests and latency; output validation does not guarantee translation accuracy.

The 0.1.8 context prompt was checked against an already loaded **Hy-MT2-1.8B** in LM Studio using two constructed 8-caption examples, with complete ID mapping and cache reuse. In those examples, “bank” was translated as a riverbank or a financial institution according to the background. This version's context mode has not yet been tested on a real 7B model or evaluated across full videos.

## Privacy and permissions

- Subtitle text and translation instructions are sent to **your configured API endpoint**. With context enabled (the default), requests also include the video title and up to 3 captions on each side of the batch, including for Hy-MT2. Disable the context setting to omit that background.
- Keys, settings, and translations stay in `chrome.storage.local`, rather than Chrome Sync. Storage access is restricted to trusted extension contexts; content scripts receive settings without the key. Local storage is not a dedicated encrypted secret vault.
- The extension has fixed access to `www.youtube.com` and asks for access to the configured API host when saving or testing its configuration.
- There is no SubPilot analytics service, account system, or translation relay. Your API provider's own data policies still apply.

## Scope and limitations

This release targets regular desktop YouTube **`/watch?v=...`** videos with manual or automatic captions. The active caption language follows YouTube's caption-track selection.

Speech recognition for videos without captions, live streams, Shorts, embedded players, and picture-in-picture overlays are outside the current scope. The extension is distributed as an unpacked extension, not a Chrome Web Store listing. YouTube caption delivery can vary between sessions; when captions cannot be read, SubPilot reports the failure and preserves native-caption display.

## Development

Use **Node.js 22+**:

```sh
npm ci
npm run build
npm test
npm run test:browser
```

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

The build bundles local Lucide icons and validates extension resources. Browser checks use a separate profile and a mock translation server. They use installed Chrome on Windows, or Playwright Chromium elsewhere (`npx playwright install chromium`). Set `YTAI_BROWSER_PATH` to override the browser executable. They do not modify your everyday Chrome profile.

Optional checks:

```sh
# A real YouTube page, with a mock translation API
node tests/youtube-smoke.mjs

# A real, already loaded local LM Studio model; sends translation requests
node tests/lmstudio-smoke.mjs

# Title/adjacent-caption examples on an already loaded local Hy-MT2 model
node tests/context-smoke.mjs
```

The YouTube smoke script defaults to the standard Windows Chrome path; set `YTAI_BROWSER_PATH` on other systems. LM Studio checks only connect to loopback addresses and do not load or switch models.

The current regression suite covers **60 core tests and 30 browser integration checks**. See the [verification notes](docs/verification.md) and the [merged-subtitle bug report](docs/bugs/merged-subtitles.md) for tested behavior and remaining real-video validation. Local profiles, API diagnostics, and screenshots generated under `.cache/` and `artifacts/` are excluded from Git.

## Contributing

Bug reports and pull requests are welcome. Include the extension version, browser version, API type, model ID, and steps to reproduce. Remove API keys, private URLs, and personal subtitle data from logs before sharing them.

## License and acknowledgements

[MIT](LICENSE). Architecture, portions of caption grouping and overlay behavior, and extension icons are adapted from [MoJo-Spy/youtube-bilingual-subs](https://github.com/MoJo-Spy/youtube-bilingual-subs). The original copyright and MIT license are preserved. UI icons use [Lucide](https://lucide.dev/) under the ISC license.

See [third-party notices](extension/THIRD_PARTY_NOTICES.md) and the [bundled Lucide license](extension/vendor/lucide.LICENSE).
