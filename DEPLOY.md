# Cloud deployment

## 1. Build and run

```bash
cp .env.example .env
# edit .env: DEEPSEEK_API_KEY and STUDY_URL
docker compose up -d --build
```

Open `http://SERVER_IP:4319`.

## 2. First login

A headless container cannot show a QR code. Options:

1. Run once with `HEADLESS=false`, expose the browser through VNC/noVNC, log in,
   then restart headless. The `profile/` volume keeps the session.
2. Copy an already authenticated Playwright profile into `./profile` from a
   desktop machine (same site/login).
3. Use a desktop machine for the first login and then move the profile folder.

## 3. Security

The GUI controls a logged-in browser. Do **not** expose port 4319 directly to
the public internet. Put it behind:

- a VPN / SSH tunnel, or
- Nginx with HTTPS and basic auth / OAuth.

Example SSH tunnel:

```bash
ssh -L 4319:127.0.0.1:4319 user@server
# then open http://127.0.0.1:4319 locally
```

## 4. Data

- `profile/` — browser login session (sensitive)
- `data/` — local progress
- `shots/` — screenshots
- `config.json` — optional local config; environment variables override it.

Never commit any of these.
