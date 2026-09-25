# ⌚ Watch Store Lab

A deliberately small e-commerce shop, built to learn the parts of a purchase
system that are actually hard: **holding stock, database transactions,
simulated payments, webhooks, duplicate events, and two customers buying the
last item at the same moment.**

Nothing is for sale. No real money moves. The payment provider is a route in
this same server, pretending.

**Stack:** Node.js + Express (CommonJS) · PostgreSQL on Supabase via `pg` ·
plain HTML, CSS and vanilla JavaScript. No build step, no framework.

---

## Running it locally

```bash
npm install
cp .env.example .env     # then fill in DATABASE_URL
npm start
```

Open <http://localhost:3000>.

Before the first run, paste `sql/01_watches_and_stock.sql` into the Supabase
SQL Editor and press Run. That creates the tables and the six watches.

---

## Deploying to Vercel

The app runs both as a normal local server and as a Vercel serverless
function, from the same code. Three pieces make that work:

| File | Job |
| --- | --- |
| `server.js` | Builds the Express app and **exports** it. It only calls `app.listen()` when run directly (`require.main === module`), which is true on your laptop and false on Vercel. |
| `api/index.js` | A two-line adaptor. Vercel looks in `/api` for functions; an Express app is already a `(req, res)` function, so we hand ours over. |
| `vercel.json` | One rewrite sending anything that is not a real file in `/public` to that function. Vercel checks the `/public` folder first, so `index.html` and `style.css` stay fast static files and only `/api/...` reaches Express. |

### Steps

1. Push the project to GitHub. (`.env` is gitignored — your secrets stay put.)
2. On Vercel: **Add New → Project**, import the repo, and deploy. No build
   command and no framework preset are needed.
3. In **Settings → Environment Variables**, add the three values from your
   `.env`: `DATABASE_URL`, `STAFF_KEY`, `WEBHOOK_SECRET`. Do **not** set
   `PORT` — Vercel handles that. Redeploy after adding them.

### ⚠️ The one gotcha: use Supabase's *pooler* connection string

Supabase's **direct** connection (`db.<project>.supabase.co:5432`) is
IPv6-only, and Vercel's functions cannot reach IPv6 addresses. A deployment
using it will work locally and then fail in production with a connection
timeout — a confusing afternoon if you do not know to expect it.

In Supabase, go to **Connect** (or Project Settings → Database) and copy the
**Transaction pooler** URI instead. It looks like:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Use that one as `DATABASE_URL` on Vercel. It also suits serverless better:
short-lived functions opening and closing connections constantly is exactly
what a pooler is for.

Our transactions (step 5 onwards) still work through it, because each
transaction is run on a single connection checked out of our own pool with
`pool.connect()` — which is precisely what transaction-mode pooling requires.

---

## Project layout

```
server.js      Express app: static files, routers, health check
db.js          the shared pg connection Pool
api/index.js   Vercel entrypoint
vercel.json    Vercel routing
routes/        one file per group of API routes
sql/           numbered SQL files, run by hand in Supabase
public/        the front end: HTML, one CSS file, one JS file per page
tests/         small Node scripts for the duplicate-webhook and race tests
LEARNING_NOTES.md   what each step taught, written up as I went
```

## API

| Method | Route | Who |
| --- | --- | --- |
| `GET` | `/api/health` | anyone |
| `GET` | `/api/watches` | anyone |
| `GET` | `/api/watches/:id` | anyone |
| `GET` | `/api/staff/stock` | staff — needs `x-staff-key` header |
| `PUT` | `/api/staff/stock/:watchId` | staff — needs `x-staff-key` header |

Orders, payments and webhooks arrive in steps 4–7.
