# Zhihuishu Course Bot

A small, self-hosted web GUI that drives a real Chromium/Edge browser to watch
Zhihuishu shared-course videos and answer chapter quizzes.

It is a **UI automation helper**, not an official Zhihuishu client. Use it only
on your own account and follow your school's rules.

## Features

- Web dashboard with live logs, progress, screenshots, pause/resume/stop
- Watches videos at 1x by default and waits for each video to finish
- Detects video pop-up questions and asks an LLM (DeepSeek compatible) for the answer
- AI takeover for unknown interactive pages, with action history to avoid repeated clicks
- Human-verification fallback: if an AI attempt fails, the GUI shows a modal and waits
- Chapter tests run as a **separate phase after all videos**, not mixed into video watching
- API keys and accounts stay in local config / environment variables, never in git

## Handoff

If you are an agent continuing this project, read [HANDOFF.md](HANDOFF.md) first.

## Requirements

- Node.js 20+
- Windows: Microsoft Edge, or Linux/macOS: Playwright Chromium
- Optional: a DeepSeek API key for AI answers

## Quick start (Windows)

1. Copy `config.example.json` to `config.json`.
2. Fill `studyUrl` with the **shared course** study page:
   `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=...`
3. Double-click `start.bat` (or run `npm start`).
4. Open http://127.0.0.1:4319.
5. Click **启动浏览器**, log in manually in the opened browser window, then **开始刷课**.

## Linux / server

```bash
npm install
npx playwright install --with-deps chromium
cp config.example.json config.json
# edit config.json or use env vars
npm start
```

For a headless server, set `headless: true` or `HEADLESS=true`.
The first login must be done in a browser profile that can be persisted in
`profile/`. A pure headless server cannot display a QR code; log in once with a
desktop/VNC session or copy an authenticated profile.

## Docker / cloud

```bash
cp .env.example .env
# edit DEEPSEEK_API_KEY and STUDY_URL
docker compose up -d --build
```

See [DEPLOY.md](DEPLOY.md) for the first-login and security notes.

## Environment variables

| Variable | Meaning |
|---|---|
| `PORT` | GUI port, default `4319` |
| `HOST` | bind address, default `127.0.0.1`; use `0.0.0.0` in Docker |
| `DEEPSEEK_API_KEY` | API key, overrides config |
| `STUDY_URL` | course study URL, overrides config |
| `HEADLESS` | `true`/`false` |
| `BROWSER_CHANNEL` | `msedge` on Windows, empty on Linux |
| `PROFILE_DIR` | browser profile directory |
| `SPEED` | playback rate, default `1` |

## Shared course warning

Do **not** use the public course page. On Zhihuishu, the public course is marked
“公开课” and gives no credit. Use the course marked **共享课** from
“在线学堂 → 我的课程”.

## Privacy

- `config.json`, `profile/`, `data/`, `shots/` and `*.log` are gitignored.
- No account, password, API key or school name is shipped in this repository.
- The GUI binds to localhost by default. If you expose it to the internet, put
  it behind authentication and HTTPS; it controls a logged-in browser.

## License

MIT. Not affiliated with Zhihuishu or DeepSeek.