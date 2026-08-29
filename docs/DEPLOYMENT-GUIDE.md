# Khelbro — Full Deployment Guide

A complete, beginner-friendly walkthrough: from creating accounts to filling the `.env`
file to going live. Two parts deploy separately — the **frontend** (static HTML) and the
**API** (Node server in `/server`).

**Recommended free stack:** Netlify (frontend) + Render (API) + the built-in SQLite
database on a Render persistent disk. Total cost to start: ₹0.

---

## 0. What you need first

- A **GitHub** account (to hold the code) — https://github.com/signup
- Your project pushed to a GitHub repo
- ~30 minutes

Push the code to GitHub if you haven't:
```bash
cd "path/to/ludo game"
git init && git add . && git commit -m "Khelbro"
# create an empty repo on github.com, then:
git remote add origin https://github.com/<you>/khelbro.git
git push -u origin main
```
> `.env` and `server/data/` are already gitignored — your secrets and database won't be
> uploaded. Good.

---

## 1. The database — MongoDB Atlas (now built in)

The app now runs natively on **MongoDB**. You already created the Atlas cluster; the
connection string lives in `server/.env` as `MONGO_URI`. Nothing else to configure —
no persistent disk needed, backups are managed by Atlas.

For a NEW Atlas account, the steps are: register → create a free **M0** cluster (Mumbai
`ap-south-1`) → Database Access: add a user + password → Network Access: allow `0.0.0.0/0`
→ Connect → Drivers → copy the string → put it in `.env` as
`MONGO_URI=…/khelbro?retryWrites=true&w=majority`.

> ⚠️ Rotate the password if it was ever shared in plaintext.

<details><summary>Old note: the previous SQLite option (no longer used)</summary>

## 1b. Legacy — SQLite (superseded)

### Option A (recommended): SQLite on a persistent disk — nothing to install
The app already uses SQLite. There is **no account to create and no connection string.**
The only requirement: on Render, attach a **persistent disk** so the database file
survives redeploys (Step 3). That's it. Skip to Step 2.

### Option B: MongoDB Atlas (only if you specifically want a managed DB)
The current code does **not** use MongoDB — choosing this means I first port the data
layer (`server/src/lib/db.js`) to Mongo, which is separate work. If you want it, here's
how to create the free database so the connection string is ready:

1. Go to https://www.mongodb.com/cloud/atlas/register and sign up.
2. **Create a free cluster** → choose the **M0 (Free)** tier → pick a region near India
   (e.g. Mumbai `ap-south-1`) → Create.
3. **Database Access** → Add New Database User → username + password (save these).
4. **Network Access** → Add IP Address → `0.0.0.0/0` (allow from anywhere) for now.
5. **Database → Connect → Drivers** → copy the connection string. It looks like:
   `mongodb+srv://<user>:<password>@cluster0.xxxx.mongodb.net/khelbro`
6. Give me that string and I'll wire the port. Until then, use Option A.

---

## 2. Prepare the code for production

Edit **`build.py`** (top of the file) and set your real values:
```python
BASE_URL = 'https://your-site.netlify.app'   # or your custom domain
API_URL  = 'https://khelbro-api.onrender.com' # your Render URL (from Step 3)
TWITTER  = '@yourhandle'                       # or ''
```
Then rebuild the pages:
```bash
npm install
npm run build
```
Run the safety check — it must pass in prod mode before you deploy:
```bash
python3 check-prod.py --prod
```
(You'll fill `API_URL` after Step 3, then rebuild once more.)

---

## 3. Deploy the API on Render

1. Go to https://render.com and sign up (use "Sign in with GitHub").
2. **New → Web Service** → connect your GitHub repo.
3. Fill in:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. **Add a persistent disk** (for SQLite — Option A):
   - Advanced → Add Disk → **Mount Path:** `/opt/render/project/src/server/data`
     (or wherever `DB_FILE` points) → Size 1 GB.
5. **Environment variables** — add these (see the full table in Step 5):
   at minimum `JWT_SECRET`, `CORS_ORIGIN`, `VAPID_*`, and leave `EXPOSE_OTP` unset.
6. Click **Create Web Service**. Wait for the deploy. Your API is now at
   `https://<name>.onrender.com`.
7. Copy that URL into `build.py` → `API_URL`, run `npm run build` again, and redeploy the
   frontend (Step 4).

> Free Render services sleep after 15 min idle and cold-start in ~30s. Fine for launch;
> upgrade later if needed.

---

## 4. Deploy the frontend on Netlify

1. Go to https://app.netlify.com and sign up with GitHub.
2. **Add new site → Import an existing project** → pick your repo.
3. Build settings:
   - **Build command:** `npm install && npm run build`
   - **Publish directory:** `.` (the repo root — the built `.html` files live here)
4. Deploy. Your site is live at `https://<name>.netlify.app`.
5. (Optional) **Domain settings → Add custom domain** to use your own domain.
6. Put the final frontend URL into `CORS_ORIGIN` on Render (Step 5) so the API accepts it.

---

## 5. Environment variables — `server/.env`

On Render, add each of these under **Environment**. Copy `server/.env.example` as your
reference.

| Variable | Value | How to get it |
|---|---|---|
| `PORT` | *(leave unset)* | Render sets it automatically |
| `NODE_ENV` | `production` | — |
| `JWT_SECRET` | a long random string | run `openssl rand -hex 32` and paste the output |
| `JWT_EXPIRES` | `7d` | — |
| `DB_FILE` | `./data/khelbro.db` | matches your persistent-disk mount |
| `CORS_ORIGIN` | `https://your-site.netlify.app` | your exact frontend URL, no trailing slash |
| `EXPOSE_OTP` | *(leave unset)* | **must NOT be `true` in production** |
| `VAPID_PUBLIC_KEY` | *(generated)* | run `node -e "console.log(require('web-push').generateVAPIDKeys())"` |
| `VAPID_PRIVATE_KEY` | *(generated)* | from the same command |
| `VAPID_SUBJECT` | `mailto:you@yourdomain.com` | your email |
| `UPLOAD_DIR` | `./data/uploads` | on the persistent disk so images survive |
| `UIDAI_CERT_PATH` | *(optional)* | path to UIDAI cert for auto-KYC; leave empty to use manual review |

**Do NOT set `ADMIN_KEY`** — admin login now uses accounts (Step 6).

---

## 6. First-run setup (once, after the API is live)

Open a shell on Render (**Shell** tab) inside the `server` directory, or run locally
against the prod DB:

**Create the first admin:**
```bash
npm run admin:create -- <username> <password> owner "Your Name"
```
Then open `https://your-site.netlify.app/admin.html` and sign in.

**In the admin console:**
1. **Payments tab** → add your UPI IDs + upload each QR code (up to 10). Players are
   spread across the active ones automatically.
2. **Settings tab** → set commission, limits, and the site notice.

---

## 7. Still needs YOUR accounts to go fully live

These are wired to placeholders — the app runs without them, but for real users:

| Feature | Create an account at | Then |
|---|---|---|
| **SMS OTP** *(hard blocker)* | MSG91 (msg91.com) or Twilio + Indian **DLT registration** | give me the API key; I wire it into `routes/auth.js` where the OTP is logged |
| **Email** | SendGrid or Resend | give me the key; wired into email verification |
| **Payments (auto)** | Razorpay (razorpay.com) merchant account | give me key + secret; I wire order + webhook. *(You can launch on manual UPI+QR without this.)* |

> Without SMS, users can't receive their login code. Manual UPI+QR deposits already work
> end to end, so you can launch on those.

---

## 8. Go-live checklist

- [ ] `build.py` → `BASE_URL` and `API_URL` are your real domains
- [ ] `npm run build` run after those edits
- [ ] `python3 check-prod.py --prod` passes
- [ ] `JWT_SECRET` is a strong random value
- [ ] `EXPOSE_OTP` is unset (not `true`)
- [ ] `CORS_ORIGIN` is your exact frontend URL
- [ ] Persistent disk attached on Render (SQLite survives redeploys)
- [ ] At least one admin account created; `ADMIN_KEY` not set
- [ ] Payment methods (UPI + QR) added in the admin console
- [ ] Everything served over HTTPS (Netlify + Render both do this by default)
- [ ] A lawyer has confirmed real-money gaming compliance for your target states

---

## Common problems

- **Frontend loads but nothing works / CORS errors** → `API_URL` in `build.py` is wrong,
  or `CORS_ORIGIN` on Render doesn't match your frontend URL exactly.
- **Login code never arrives** → SMS gateway not wired yet (Step 7). In the meantime, with
  `EXPOSE_OTP` unset you cannot see codes — set it temporarily only for your own testing.
- **Database resets on redeploy** → no persistent disk attached (Step 3.4).
- **QR images disappear** → `UPLOAD_DIR` is not on the persistent disk.
- **Push notifications don't work** → must be HTTPS; check `VAPID_*` are set.
