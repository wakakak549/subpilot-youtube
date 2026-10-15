# SubPilot

**Translate YouTube captions with your own AI API or a local LM Studio model.**

English | [简体中文](README.zh-CN.md)

SubPilot is a Chrome Manifest V3 extension that translates existing YouTube captions and displays them in sync with playback. Bring your own API endpoint, key, and model; no SubPilot account or backend is required.

Current version: **0.1.6**. The settings and popup are currently in Simplified Chinese. The default translation language is Simplified Chinese and can be changed in settings.

## Features

- Bilingual, translation-only, and original-only display, with adjustable font sizes and fullscreen support.
- OpenAI Chat Completions-compatible APIs, including local LM Studio servers.
- Up to **100 subtitle segments per request**, with a configurable **15–600 second** look-ahead window.
- Local translation cache, bounded retries, cancellation on video changes, and native-caption fallback on errors.
- Dedicated Hy-MT2 prompts and output validation to reject merged paragraphs, missing IDs, and echoed instructions.
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

To update an unpacked installation, replace or pull the files, reload SubPilot on `chrome://extensions/`, then refresh YouTube. Version 0.1.6 discards older translation caches while keeping API settings.

## Configure your API

SubPilot sends requests to **`/chat/completions`** under the base URL. Responses API-only services are not supported. Use a model ID actually served by your provider; the prefilled ID does not grant model access.

| Setting | Default / behavior |
| --- | --- |
| API base URL | `https://api.openai.com/v1` |
| Model | `gpt-6.1-sol`; replace with your provider's model ID |
| API format | Automatic; loopback URLs use compatibility mode |
| Target language | Simplified Chinese; editable |
| Strict JSON output | Enabled; disable if your service lacks JSON Schema support |
| Reasoning effort | Low; choose Auto if your cloud service rejects the parameter |
| Request timeout | 120 seconds; configurable from 15 to 300 |
| Batch size | 6 segments; configurable from 1 to 100 |
| Look-ahead | 45 seconds; configurable from 15 to 600 |

For a remote third-party compatible endpoint, choose **LM Studio / 兼容接口** under **接口兼容设置**. This uses `max_tokens` and omits OpenAI-specific reasoning parameters. For a local proxy that expects OpenAI parameters, explicitly choose **OpenAI**.

The batch size is an upper bound. The current playback position, look-ahead window, and cache determine how many segments are sent. For example, try 30 segments and 180 seconds before increasing further. Larger batches can increase latency and output-format failures.

API usage, including the connection test, is handled and billed by your configured provider. SubPilot does not include API credit or reuse a ChatGPT/Codex login.

### LM Studio

1. Load a text model and start LM Studio's local server.
2. Enter **`http://localhost:1234/v1`** as the base URL. Bare loopback URLs such as `http://localhost:1234` or `http://127.0.0.1:1234` are also normalized to `/v1`.
3. Click the refresh button next to the model field to fetch model IDs. Select an **already loaded** model using its exact ID.
4. Leave the key empty if server authentication is disabled; otherwise enter the server token. Save and test the connection.

For a LAN-hosted LM Studio server, choose compatibility mode explicitly and make sure the server is reachable from your browser. Increase the timeout for slower models.

### Hy-MT2

Model IDs containing the supported `hy-mt2` marker automatically use a plain-text translation prompt instead of system messages or JSON Schema, with the sampling settings recommended by the [Hy-MT2 model card](https://huggingface.co/tencent/Hy-MT2-7B-GGUF). Use the model ID supplied by your server; a custom alias without this marker will not activate the special handling.

Hy-MT2 batches contain only the requested subtitles. Incomplete numbering triggers individual retranslations of the entire batch, because later IDs may have shifted after the model merged earlier lines. Clearly oversized translations and echoed instructions are rejected before display or caching. This recovery adds requests and latency; output validation does not guarantee translation accuracy.

## Privacy and permissions

- Subtitle text, nearby context for general-purpose models, and translation instructions are sent to **your configured API endpoint**. Hy-MT2 requests omit the extra context.
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
```

The YouTube smoke script defaults to the standard Windows Chrome path; set `YTAI_BROWSER_PATH` on other systems. LM Studio checks only connect to loopback addresses and do not load or switch models.

The current regression suite covers **50 core tests and 24 browser integration checks**. See the [verification notes](docs/verification.md) and the [merged-subtitle bug report](docs/bugs/merged-subtitles.md) for tested behavior and remaining real-video validation. Local profiles, API diagnostics, and screenshots generated under `.cache/` and `artifacts/` are excluded from Git.

## Contributing

Bug reports and pull requests are welcome. Include the extension version, browser version, API type, model ID, and steps to reproduce. Remove API keys, private URLs, and personal subtitle data from logs before sharing them.

## License and acknowledgements

[MIT](LICENSE). Architecture, portions of caption grouping and overlay behavior, and extension icons are adapted from [MoJo-Spy/youtube-bilingual-subs](https://github.com/MoJo-Spy/youtube-bilingual-subs). The original copyright and MIT license are preserved. UI icons use [Lucide](https://lucide.dev/) under the ISC license.

See [third-party notices](extension/THIRD_PARTY_NOTICES.md) and the [bundled Lucide license](extension/vendor/lucide.LICENSE).
