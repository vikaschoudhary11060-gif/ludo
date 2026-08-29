# Deploying Khelbro

Two pieces deploy separately: the **static frontend** (24 HTML pages + assets) and the
**Node API** (`/server`). A free split that works well: **Netlify/Cloudflare Pages** for the
frontend, **Render** for the API, **MongoDB Atlas** or the built-in SQLite volume for data.

---

## Before you build — change these 3 constants

Open `build.py` (top of file) and set:

```python
BASE_URL = 'https://your-domain.com'      # your real frontend domain (for SEO, sitemap, OG)
API_URL  = 'https://api.your-domain.com'  # your API server's public origin
TWITTER  = '@yourhandle'                  # or ''
```

Then rebuild:  `npm run build`

That single change updates the API origin, socket.io origin, canonical URLs, Open Graph,
sitemap and robots across all 24 pages.

## Server env — `server/.env` for production

| Var | Dev | Production |
|---|---|---|
| `JWT_SECRET` | anything | **long random string** — `openssl rand -hex 32` |
| `EXPOSE_OTP` | `true` | **`false`** — never return OTP codes in prod |
| `OTP_RATE_LIMIT` | 200 | **unset** (defaults to 5) |
| `CORS_ORIGIN` | localhost | `https://your-domain.com` |
| `PORT` | 4000 | provided by the host |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | set | keep (free push) |
| `UIDAI_CERT_PATH` | empty | path to UIDAI cert (for auto-KYC) |
| `ADMIN_KEY` | — | **remove** — replaced by admin accounts |

Create the first admin on the server:
```bash
npm run admin:create -- <username> <password> owner "Your Name"
```

## Still needs your accounts (each is free-tier capable)

| Feature | What to add |
|---|---|
| **Real SMS OTP** | MSG91 / Twilio account + DLT registration; wire into `routes/auth.js` where it `console.log`s the code |
| **Real email** | SendGrid / Resend; wire into `routes/users.js` email-verify |
| **Payments** | Razorpay merchant keys; wire order + webhook into `routes/wallet.js` deposit |

Until SMS is wired, **no one can log in without reading the server console** — this is the
one hard blocker for real users.

## Data

- SQLite lives in `server/data/khelbro.db` (gitignored). On Render, attach a **persistent
  disk** mounted at `server/data` or the DB resets on redeploy.
- To move to MongoDB Atlas, the data layer in `lib/db.js` would need porting; SQLite on a
  persistent disk is the faster path to launch.

## Security checklist

- [ ] `JWT_SECRET` is a strong random value
- [ ] `EXPOSE_OTP=false`
- [ ] `CORS_ORIGIN` is your exact domain, not `*`
- [ ] Serve everything over **HTTPS** (push and service workers require it)
- [ ] `.env` and `server/data/` are gitignored (already are)
- [ ] At least one admin account created; `ADMIN_KEY` removed
- [ ] Rate limits left at defaults (helmet + express-rate-limit already on)
- [ ] Confirm the legal/gaming compliance for your states with a lawyer before going live

## Build & run

```bash
# frontend
npm install && npm run build          # outputs static .html + assets/

# API
cd server && npm install && npm start
```

Serve the repo root as static files (any static host). Point the API host at `server/`.
