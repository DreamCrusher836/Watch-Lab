# Watch Store Lab — Learning Notes

A practice project for learning how a real purchase system works:
stock, orders, database transactions, simulated payments, webhooks,
duplicate events, and two people buying the last item at once.

**Stack:** Node.js + Express (CommonJS) · PostgreSQL on Supabase via `pg` · plain HTML/CSS/JS

---

## Step 1 — The database tables and the server skeleton

### What this step does

We created the two foundation tables (`watches` and `stock`), filled them with
six watches, and built the smallest possible Express server that can serve a web
page and prove it can talk to that database.

Nothing is for sale yet. This step is the shop's empty building plus the stock
room: walls up, shelves labelled, lights on.

### Key concepts, explained simply

**Why prices are stored in cents**
Computers store decimals imprecisely — `0.1 + 0.2` does not equal exactly `0.3`.
With money, tiny errors become real missing euros. So we store whole numbers of
cents (`24900`) and only divide by 100 when displaying a price (`€249.00`).
Stripe, PayPal and every serious payment system work this way.

**Why stock lives in its own table**
A watch's name and price are read constantly and change almost never. Its stock
count changes on *every sale*. Splitting them means that when two customers
compete for the last watch (step 9), we lock one tiny stock row rather than the
whole product record. It is the same reason a shop keeps a stock sheet separate
from the product catalogue.

**Foreign key**
A rule saying "this column must point at a real row in that other table".
`stock.watch_id references watches(id)` means the database itself refuses to
create a stock row for a watch that does not exist. It is a shelf label that
must match a real product in the catalogue.

**Unique constraint**
`unique` on `stock.watch_id` means a watch can have at most *one* stock row.
That is what makes the relationship one-to-one, and it prevents two competing
stock counts for the same watch.

**Check constraint**
`check (quantity >= 0)` is a rule the database will not break, no matter what
code asks it to. Our JavaScript will also check stock — but JavaScript can have
bugs, and the database cannot be talked around. "Never sell a watch we do not
have" is too important to guard in only one place.

**Connection pool**
Opening a database connection is slow (network handshake plus login). A pool
keeps a handful of connections open and reuses them — like a taxi rank, where
taxis return to wait for the next passenger instead of being built from scratch
each time. We create exactly one pool, in `db.js`, shared by the whole app.

**Parameterised queries**
We write `select * from watches where id = $1` and pass the value separately.
We never glue values into the SQL string. Glueing allows **SQL injection**,
where a visitor types SQL into a form field and our database obediently runs it.
With `$1`, Postgres treats the value as *data only*, never as instructions.

**Middleware**
A function Express runs on every request before it reaches our route — like
airport security, which every passenger passes through on the way to the gate.
`express.json()` turns an incoming JSON body into a JavaScript object on
`req.body`.

**Environment variables (`.env`)**
Secrets (the database password, the staff key) live in a `.env` file that is
listed in `.gitignore` and never committed. `.env.example` is the shareable
template that documents *which* settings exist, with fake values.

### The most important bits of code

**Creating the stock table (`sql/01_watches_and_stock.sql`)**

```sql
create table stock (
  id serial primary key,
  watch_id integer not null unique references watches(id) on delete cascade,
  quantity integer not null check (quantity >= 0),
  updated_at timestamptz not null default now()
);
```

Three separate guarantees in four lines: `references` = the watch must exist;
`unique` = one stock row per watch; `check` = stock can never go negative.

**The shared pool (`db.js`)**

```js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },   // Supabase requires an encrypted connection
});

async function query(text, params) {
  const result = await pool.query(text, params);
  return result;
}

module.exports = { query, pool };
```

We export **both**. `query` is for ordinary one-off queries. `pool` is for
step 5, when a transaction needs to hold one single connection across several
statements.

**Serving the front end (`server.js`)**

```js
app.use(express.static(path.join(__dirname, 'public')));
```

One line turns `/public` into a website. `__dirname` means "the folder this file
is in", so it works no matter where the server was started from.

**The health check (`server.js`)**

```js
app.get('/api/health', async function (req, res) {
  try {
    const result = await db.query('select now() as database_time');
    res.json({ ok: true, databaseTime: result.rows[0].database_time });
  } catch (error) {
    console.error('Health check failed:', error.message);   // detail for us
    res.status(500).json({ ok: false, message: 'The server could not reach the database.' });
  }
});
```

Note the split: the **full** error goes to our terminal, the visitor gets a
short message. Database errors can leak table names and file paths that help an
attacker, so detail stays in the log.

### Answers to the Step 1 questions

**Why store `24900` instead of `249.00`?**
Computers store decimals as binary fractions, and most decimals have no exact
binary form — just as `1/3` has no exact decimal form. Run
`node -e "console.log(0.1 + 0.2)"` and you get `0.30000000000000004`. In a
shopping cart those tiny errors become real missing euros that nobody can
trace. Integers have no such problem: `18990 × 3 = 56970`, exactly, always.

**What does `references watches(id)` forbid?**
Two things: you cannot insert a stock row pointing at a watch that does not
exist, and you cannot delete a watch that still has a stock row pointing at it
(unless you say what should happen — we said `on delete cascade`). The problem
it prevents is called an **orphan row**: a stock entry for a product nobody
can find.

**If JavaScript checks stock, why also `check (quantity >= 0)`?**
They guard different things. The JavaScript check protects against *customers*
— and lives in code you will edit constantly, so it is code you can break. The
database check protects against *everything else*: a future bug, a route added
in step 6 that forgets to check, a script, or you fixing something by hand at
1am. This is **defence in depth**: the more expensive the mistake, the more
independent layers should have to fail before it happens.

---

## Step 2 — The watch API and the staff stock routes

### What this step does

We gave the database a front desk. Four routes now exist:

| Method | Route | Who can call it |
| --- | --- | --- |
| `GET` | `/api/watches` | anyone |
| `GET` | `/api/watches/:id` | anyone |
| `GET` | `/api/staff/stock` | staff only |
| `PUT` | `/api/staff/stock/:watchId` | staff only |

The public ones only ever *read*, so there is nothing to protect. The staff
ones can *change* data, so they are behind a key.

### Key concepts, explained simply

**Router**
A mini-app holding a group of related routes. Instead of piling everything into
`server.js`, the watch routes live in `routes/watches.js` and the staff routes
in `routes/staff.js`. `server.js` just plugs each one in at an address. Like
the departments of a shop, each with its own counter, and a directory at the
entrance saying which floor each is on.

**JOIN**
Our data sits in two tables, but the browser wants one tidy object per watch:
name, price *and* stock. A JOIN glues rows from two tables together using
something they share:

```sql
from watches
join stock on stock.watch_id = watches.id
```

"For each watch, find the stock row whose `watch_id` matches this watch's `id`,
and show them side by side." It is putting the catalogue next to the stock
sheet and lining the pages up by product number.

**URL parameters arrive as text**
`/api/watches/4` puts the *string* `"4"` into `req.params.id`, not the number
`4`. Every part of a URL is text. So we convert with `Number()` and then check
`Number.isInteger()`, which conveniently rejects `"banana"` (`NaN`) and `4.5`
in the same test.

**Status codes are a vocabulary, not decoration**
- `200` here you go
- `400` **you** asked wrong (bad id, negative quantity)
- `401` I do not know who you are (missing or wrong staff key)
- `404` there is no such thing (watch id 999)
- `500` **I** broke (database down)

The `400` vs `500` split matters: it tells whoever is debugging whose fault it
is. A query that finds nothing is *not* an error — it succeeded and the honest
answer is "zero rows" — so we check `result.rows.length` ourselves and send 404.

**Custom middleware, and `next()`**
Our staff check is a function that runs before the real route:

```js
function requireStaffKey(req, res, next) {
  const providedKey = req.header('x-staff-key');
  if (!providedKey || providedKey !== process.env.STAFF_KEY) {
    return res.status(401).json({ error: 'Staff key missing or incorrect.' });
  }
  next();
}

router.use(requireStaffKey);   // applies to every route in the file
```

`next()` means "this request passed, carry on". *Not* calling it means the
request stops here. It is a bouncer on the door.

Two deliberate choices. The key travels in a **header**, not the URL, because
URLs end up in server logs, browser history and the address bar — headers do
not. And `router.use(...)` applies it to every route at once, because the day
you remember to add it route-by-route is the day you forget one.

This is a **mock** stand-in for real authentication. A real shop would have
user accounts, hashed passwords, sessions or JWTs, and a role on each account.

**`returning`**
A Postgres treat. An `UPDATE` normally just tells you *how many* rows changed.
Adding `returning` hands back the changed rows too:

```sql
update stock
   set quantity = $1, updated_at = now()
 where watch_id = $2
returning watch_id, quantity, updated_at
```

One trip to the database instead of an update followed by a select. It also
gives us our "does this watch exist?" answer for free: if nothing comes back,
nothing matched, so we reply 404.

**Why `PUT` and not `POST`?**
Rough rule: `POST` creates something new, `PUT` sets a thing to exactly this
value. `PUT` is also meant to be safe to repeat — sending "set it to 12" three
times leaves it at 12, not 36. (The word for that is **idempotent**, and it
comes back in a big way with webhooks in step 8.)

### Deploying to Vercel — what changed and why

Vercel does not run a long-lived server. It wakes the app for one request and
puts it back to sleep, so nothing may call `app.listen()`. Three small pieces
let one codebase do both:

```js
// server.js
if (require.main === module) {     // "was I started directly?"
  app.listen(port, ...);           // true on your laptop, false on Vercel
}
module.exports = app;
```

`api/index.js` is a two-line adaptor (`module.exports = require('../server.js')`)
because Vercel looks in `/api` for functions, and an Express app is already a
`(req, res)` function. `vercel.json` sends anything that is not a real file in
`/public` to it.

**The gotcha worth remembering:** Supabase's *direct* connection
(`db.<project>.supabase.co:5432`) is IPv6-only and Vercel cannot reach it. It
works locally and then times out in production. On Vercel, use the
**transaction pooler** string (`...pooler.supabase.com:6543`) instead.

### The front end so far

`public/style.css` is now a small design system: colours, spacing and fonts
defined once as CSS custom properties at the top, then components (`.card`,
`.btn`, `.badge`, `.watch-card`, `.table-wrap`) built from those tokens. Steps
3–7 add pages, not new styling vocabulary.

The one layout line worth knowing:

```css
grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
```

"Fit as many columns of at least 260px as will comfortably go." That is the
entire responsive watch grid — one column on a phone, three on a laptop, with
no media queries at all.
