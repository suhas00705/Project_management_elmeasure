# PulseBoard — Self-Hosted Server Setup

## What's in this folder
- `server.js` — the whole app: serves the dashboard and the two Zoho API endpoints (`/api/leads`, `/api/potentials`)
- `zohoAuth.js` — handles refreshing the Zoho access token
- `public/index.html` — the dashboard itself (Leads / Potentials / Friday Review tabs)
- `package.json` — dependencies (Express + dotenv)
- `.env` — your credentials (already has Client ID/Secret filled in — **add the refresh token before running**)
- `.gitignore` — makes sure `.env` and `node_modules` never get committed to Git by accident

## Fill in the one missing value
Open `.env` and replace:
```
ZOHO_REFRESH_TOKEN=PASTE_YOUR_REFRESH_TOKEN_HERE
```
with the actual refresh token (the same one that was working on Netlify — if you don't have it saved, you'll need to redo the Zoho authorization link + token exchange once to get a new one, same process as before).

## Run it locally to test
```bash
npm install
npm start
```
Then open `http://localhost:3000` — you should see the dashboard with all three tabs, and Leads/Potentials should show live Zoho data if the refresh token is correct.

## Run it in production (what IT will actually do)
1. Copy this whole folder onto the server.
2. `npm install --production`
3. Install PM2 to keep it running: `npm install -g pm2`
4. Start it: `pm2 start server.js --name pulseboard`
5. Make it survive reboots: `pm2 save && pm2 startup` (follow the printed instructions)
6. Point Nginx (or Apache) at `http://localhost:3000` as a reverse proxy, with SSL termination handled by Nginx — this is the piece that makes `https://projectmanagement.elmeasure.com` work.

A minimal Nginx config for that last step:
```nginx
server {
    listen 443 ssl;
    server_name projectmanagement.elmeasure.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Security notes for IT
- `.env` contains real secrets — set file permissions so only the app's service account can read it (`chmod 600 .env`), and make sure it's never committed to a public repo (the `.gitignore` already excludes it).
- If this ever gets pushed to a Git repository, double check `.env` didn't get included — GitHub's push protection usually catches this, but worth confirming.
