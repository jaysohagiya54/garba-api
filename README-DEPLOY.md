# Garba Guide — deploy to Render

A zero-dependency Node server. It serves the public site and accepts price
updates pushed from your signed-in browser.

**It never contacts BookMyShow or District.** It can't: both refuse requests
from datacenter IPs with a 403, which is why the browser does the reading.

---

## Why it's split this way

| Job | Where it runs | Why |
|---|---|---|
| Serving the site | Render | needs a public URL |
| Storing prices | Render | one source of truth for all visitors |
| **Reading District** | **Render, automatically** | its event API answers plain server requests |
| **Reading BookMyShow** | **your Chrome** | Cloudflare challenges anything else |

A cron job on Render fetching BMS would get a 403 on every request. Getting
past that means faking browser fingerprints and rotating proxies — brittle,
and against both platforms' terms. Your browser is already allowed to read
those pages, so it does that part.

---

## Deploy

### 1. Get the code to a Git repo

```bash
cd garba-server
git init
git add .
git commit -m "Garba Guide server"
git branch -M main
git remote add origin https://github.com/<you>/garba-guide.git
git push -u origin main
```

### 2. Create the Render service

Render dashboard → **New** → **Web Service** → connect the repo.

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | *(leave empty)* |
| Start command | `node server.js` |
| Health check path | `/healthz` |
| Instance type | **Free** |

### 3. Environment variables

| Key | Value |
|---|---|
| `INGEST_TOKEN` | a long random string — this is your upload password |
| `DATA_DIR` | **leave unset on the free plan** — there is no disk to point it at |
| `POLL_HOURS` | how often to refresh District. Default `12` (twice a day). `0` disables |

Generate a token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Attach a disk (recommended)

Render → your service → **Disks** → Add, mount path `/var/data`, 1 GB.

Without a disk the server still works, but a restart drops back to the
snapshot committed in `data/snapshot.json` — the prices as of 4 October.
Push again after any restart, or keep the disk.

**On the free plan** the service also sleeps after inactivity and the disk
isn't available, so the first visitor waits ~30s for a cold boot and your
pushes don't survive restarts. Starter avoids both.

---

## Updating prices

### From the browser (no files)

1. Open `https://in.bookmyshow.com/explore/home/ahmedabad`, signed in.
2. F12 → Console → paste all of `garba-bulk-bms.js` → Enter.
3. Click **Start**, wait for DONE (~2 min).
4. Click **⚙**, enter your Render URL and `INGEST_TOKEN` (stored in that
   browser, asked once).
5. Click **Push**. The log confirms how many listings went live.
6. Repeat on `https://www.district.in/` with `garba-bulk-district.js`.

The site is updated the moment the push succeeds. No redeploy, no files.

### Or save a file and upload it yourself

**Save** instead of **Push** writes the JSON to Downloads. Then:

```bash
curl -X POST https://<your-app>.onrender.com/api/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @garba-bulk-bookmyshow.json
```

Prefer this if you'd rather not have the token sitting in browser storage
on a site you don't control. Either way the token only grants price
uploads, and you can rotate it in Render at any time.

---

## Twice a day

**District is already automatic.** The server refreshes all 24 District
listings on boot and every `POLL_HOURS` (12 by default), straight from
District's own event API — no browser, no action from you. It takes ~30
seconds and publishes the real convenience fee and GST rates per ticket.

**BookMyShow still needs you**, because Cloudflare challenges anything that
isn't a real browser. Run `garba-api-bms.js` in your tab and hit Push.

The push is one click, but something has to trigger it. Options, cheapest first:

- **Do it yourself**, morning and evening, during the nine nights. The page
  tells visitors how stale it is, so a missed slot degrades honestly.
- **A Chrome extension** with `chrome.alarms` to run the reader and push on a
  schedule whenever Chrome is open. Ask me and I'll build it.
- **A scheduled task on your PC** driving real Chrome via `puppeteer-core`
  with a profile you sign into once. True twice-daily, needs the PC awake.

What *won't* work is a cron job on Render — that's the 403 again.

---

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | the site (132 KB, 30 KB gzipped) |
| `GET /img/<hash>.jpg` | posters, cached for a year |
| `GET /api/prices` | the raw price data |
| `GET /api/status` | data date, age, counts, whether dates are mixed |
| `POST /api/ingest` | upload prices (Bearer token) |
| `POST /api/poll-district` | refresh District now (Bearer token) |
| `GET /healthz` | health check |

### Ingest safety

- Wrong or missing token → `401`.
- Prices for a URL not in `data/bms.txt` / `data/district.txt` → ignored.
- An upload covering under half your priced listings → `409`, nothing
  changes. That's an interrupted reader run. Add `?force=1` to accept it.
- A rebuild failure rolls the data back.
- 12 uploads per IP per 10 minutes.

### The disk wins over the bundled snapshot

On boot the server loads `$DATA_DIR/prices.json` if it exists, and only falls
back to `data/snapshot.json`. So deploying new code with a fresher snapshot
does **not** replace live prices on the disk — which is usually what you want,
since the disk is normally newer. To force the snapshot, delete
`prices.json` from the disk (Render shell) and restart.

### The data date is the oldest, not the newest

If you push one listing, the site keeps claiming the *older* date for the
catalogue, because 84 listings really are that old. `/api/status` sets
`mixedDates: true` when checks span several days. This is deliberate — the
staleness banner has to be trustworthy.

---

## Checks

```bash
npm run selftest
```

Boots the server on port 4187 and runs 36 assertions over every route:
page size, poster extraction, ETag revalidation, CORS preflight, token
rejection, the partial-upload guard, the date-skew protection, and a real
two-platform upload. Run it before every deploy.
