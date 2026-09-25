# Watch Store Lab — Learning Notes

A practice project for learning how a real purchase system works:
stock, orders, database transactions, simulated payments, webhooks,
duplicate events, and two people buying the last item at once.

**Stack:** Node.js + Express (CommonJS) · PostgreSQL on Supabase via `pg` · plain HTML/CSS/JS

---

## Contents

| Step | What it covers | The big idea |
| --- | --- | --- |
| [1](#step-1--the-database-tables-and-the-server-skeleton) | Tables, seed data, the server | Foreign keys, constraints, connection pools |
| [2](#step-2--the-watch-api-and-the-staff-stock-routes) | Watch API, staff routes | Routers, JOINs, status codes, middleware |
| [3](#step-3--the-shop-front-and-the-stock-room) | Shop front, stock room | `localStorage`, event delegation, escaping HTML |
| [4](#step-4--orders-the-cart-page-and-a-route-built-to-be-broken) | Orders, cart, naive order route | One-to-many, copying vs linking, indexes |
| [5](#step-5--transactions) | **Transactions** | `BEGIN` / `COMMIT` / `ROLLBACK`, race conditions, deadlocks |
| [6](#step-6--the-simulated-payment-provider) | Simulated payment | What a webhook is, event ids, shared secrets |
| [7](#step-7--processing-the-webhook) | Webhook processing | Idempotency, `on conflict do nothing`, reply codes |
| [8](#step-8--proving-the-webhook-is-idempotent) | Duplicate webhook test | Testing without a framework; sabotage-testing |
| [9](#step-9--proving-the-shop-cannot-oversell) | Race condition test | Timing-independent assertions, defence in depth |
| [10](#step-10--the-whole-thing-end-to-end) | End-to-end walkthrough | Putting it together |
| [Glossary](#glossary) | Every term in one place | |

### The five rules this shop is built on

1. **The server always looks up the real price from the database.** Prices sent
   from the browser are ignored.
2. **You cannot order more than is in stock**, and quantity must be a whole
   number from 1 to 5.
3. **Stock is held when the order is created**, so nobody else can take it. If
   the payment fails, it goes back.
4. **An order moves from `pending` to `paid` or `failed` once.** A finished
   order is never changed again.
5. **The same webhook event is only ever processed once.** Duplicates are
   ignored safely.


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

### Answers to the Step 2 questions

**If you deleted `next()`** — every staff request with a *correct* key would hang
forever. The bouncer checks your ID, finds it fine, and then just stands there.
`next()` is the only thing that says "carry on to the actual route".

**Why not put the key in the URL** — URLs get written down everywhere: server
access logs, browser history, and the `Referer` header sent to any site you
link to. The secret ends up in half a dozen text files you forgot existed.
Headers are not logged by default.

**Where the 404 comes from** — from *us*, not the database. The query worked
perfectly; the honest answer was "zero rows". We count them ourselves
(`if (result.rows.length === 0)`) and choose to reply 404. It is not a 500
because nothing broke: 500 means "I am broken", 404 means "that does not
exist".

---

## Step 3 — The shop front and the stock room

### What this step does

Two real pages. `index.html` fetches `/api/watches` and draws a card per watch,
with a stock badge and an Add to cart button that is genuinely disabled when
the watch is sold out. `staff.html` takes the staff key, loads the stock sheet,
and lets staff change quantities that save straight to the database.

The cart itself is just a note in the customer's pocket — see below.

### Key concepts, explained simply

**`localStorage`, and why the cart holds no prices**
`localStorage` is a small box of text the browser keeps on the visitor's own
computer. It survives closing the tab. Our server never sees it.

It is a scrap of paper in the customer's pocket, not a note behind the counter.
So: the cart follows the *browser*, not the person (open the shop on your phone
and it is empty), and **the customer can edit it**. Which is why we store only
this:

```js
cart.push({ watchId: watchId, quantity: 1 });
```

No price. When the order is placed in step 4, the server looks every price up
in the database and ignores anything the browser claims. Otherwise someone
could edit their own cart to say a €329 chronograph costs €1.

**Browser checks are a courtesy; server checks are the law**
`addToCart` refuses to go past the stock number, and the staff quantity box has
`min="0" max="999"`. Neither is security — a visitor can send anything straight
to the API and skip our pages entirely. They exist so the customer finds out
*now* rather than at checkout. The binding checks live in `routes/staff.js` and
(from step 4) in the order route.

**Event delegation**
Instead of attaching a listener to each of six buttons, we attach **one** to
the grid that contains them:

```js
grid.addEventListener('click', handleGridClick);
```

Clicks bubble upwards from the element you hit to its parents, so the grid
hears them all. Why bother? Because the buttons do not exist when the page
loads — we create them after the data arrives. One listener on the container
works for buttons added at any time. A receptionist for the whole floor
instead of a secretary at every desk.

Inside the handler, `event.target.closest('button')` walks upwards from
whatever was clicked to find the button, so it still works if the click landed
on the text inside it.

**Data attributes**
`data-watch-id="4"` parks a value on an HTML element so JavaScript can read it
back later as `button.dataset.watchId`. It saves keeping a separate list of
which button belongs to which watch. Attributes are always **text**, so convert
with `Number()` before comparing.

**`fetch` does not throw on 404 or 500**
It only throws if the request could not be made at all. A 500 is a perfectly
successful *request* that carried bad news. So you must check yourself:

```js
if (!response.ok) {
  throw new Error('The server replied ' + response.status);
}
```

Forgetting this is one of the most common beginner bugs — the page silently
does nothing instead of showing an error.

**`event.preventDefault()` on a form**
A form's natural behaviour is to reload the whole page. We want to stay put and
talk to the server ourselves, so we cancel it. Forget this line and the page
flashes and appears to do nothing at all.

**Escaping HTML (XSS)**
We build cards by writing HTML as text. If a watch were ever named
`<img src=x onerror="steal()">`, the browser would run that as part of our
page — an attack called **cross-site scripting**. Our six names are our own and
safe, but the habit matters: the moment any text comes from a customer (a name
at checkout, a review), this is what stops it.

```js
function escapeHtml(text) {
  const holder = document.createElement('div');
  holder.textContent = text;     // the browser treats this as plain text
  return holder.innerHTML;       // read it back, now escaped: "<" is "&lt;"
}
```

**Why the staff key is not saved anywhere**
It lives in an ordinary variable and nowhere else. `localStorage` would keep it
on disk forever, readable by any script on the page, left behind on a shared
computer long after the person walked away. A variable disappears the moment
the tab closes. The cost is retyping it after a refresh — the right trade.

**`disabled` must mean both things**
The sold-out button carries the real `disabled` attribute, so the browser
refuses to fire a click *and* our CSS greys it out. Looking disabled and being
disabled always go together; either one alone is a bug.

### A genuine bug we hit, and the lesson in it

The cart badge kept showing a pointless "0" even though the JavaScript set
`badge.hidden = true`.

The HTML `hidden` attribute is meant to hide an element via the browser's
built-in rule `[hidden] { display: none }`. But our own rule
`.cart-badge { display: inline-block }` is **more specific** — a class beats a
bare attribute — so ours won and the badge stayed visible.

```css
[hidden] {
  display: none !important;
}
```

`!important` is normally a bad habit because it makes CSS hard to reason about.
This is the exception it exists for: "hidden means hidden, no arguments." Worth
remembering, because any project that styles an element it also hides will hit
this.

### One CSS line worth knowing

```css
grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
```

"Fit as many columns of at least 260px as will comfortably go." That is the
entire responsive grid — one column on a phone, three on a laptop — with no
media queries at all.

### Answers to the Step 3 questions

**If the cart stored the price** — the customer could open dev tools, change
`24900` to `1`, and check out. The server would build the order from *their*
number. Storing only the id means there is nothing to tamper with.

**Why per-button listeners would be harder** — the buttons do not exist when
the page loads. `shop.js` creates them *after* the watches arrive, so there is
nothing to attach to at startup, and you would have to re-attach six listeners
every time you redraw. The grid is there from the beginning and never goes away.

**Why the server checks stock again** — `addToCart` runs on the customer's
computer, and so does the cart it guards. Anyone can skip the page and send a
request straight to `/api/orders` asking for 500 watches. The browser check is
a courtesy; the server check is binding.

---

## Step 4 — Orders, the cart page, and a route built to be broken

### What this step does

Two new tables (`orders` and `order_items`), a working cart page with a
checkout form, and `POST /api/orders`, which turns a cart into a real order and
holds the stock.

**The order route is deliberately unfinished.** It works when everything goes
right and fails quietly when anything goes wrong. Step 5 breaks it on purpose,
explains why, and fixes it with a transaction.

### Key concepts, explained simply

**One-to-many**
An order can contain any number of watches, and a column cannot hold "any
number of things". So one row in `orders` has many rows in `order_items`
pointing back at it. This is the commonest shape in all of database design:
think of the order as the receipt header and the items as the printed lines
below it.

**Copying data instead of linking to it**
`order_items.unit_price_cents` stores the price of one watch *at the moment of
the order*, rather than looking it up from `watches` later. Because prices
change. If the Apex Chrono rises to €399 next year, an order placed today must
still say €329 — otherwise every old receipt silently rewrites itself and your
accounts stop matching what the customer's bank actually charged.

Knowing when to **copy** a value and when to **link** to it is one of the real
skills of database design. The rule of thumb: link to things that should stay
current, copy things that are a record of a moment.

**Two foreign keys, deliberately different**

```sql
order_id integer not null references orders(id) on delete cascade,
watch_id integer not null references watches(id),
```

Delete an order and its lines go with it — a line with no order is meaningless.
But there is **no** cascade on `watch_id`: if someone tries to delete a watch
that appears on a past order, the database refuses. That is correct. You must
not be able to erase a watch and silently destroy the history of who bought it.

**Constraining the status column**

```sql
status text not null default 'pending'
  check (status in ('pending', 'paid', 'failed')),
```

Without the check, a typo anywhere in our code — `'Paid'`, `'padi'`,
`'complete'` — would be stored happily, and every later query looking for
`'paid'` would quietly miss those orders. Nothing would ever error. The numbers
would just be wrong. Those are the worst bugs there are.

**Indexes**
We will constantly ask "give me all the lines for order 12". Without an index,
Postgres reads *every* row in `order_items` and checks each one — fine with 20
rows, painful with two million.

```sql
create index order_items_order_id_index on order_items (order_id);
```

An index is the alphabetical index at the back of a book: a pre-sorted lookup so
you can jump to the right page instead of reading the whole book. The trade-off
is that reads get faster and writes get slightly slower, so you add them where
you know you will search — not everywhere.

**Holding stock at order time, not payment time**
We subtract the stock the moment the order is created. The watch goes behind the
counter with the customer's name on it while they get their wallet out, so
nobody else can take it. If the payment then fails, step 7 puts it back.

**409 Conflict**
A new status code for us. The request was perfectly well formed — it just
clashes with the state of the world. "Somebody else got there first." That is
exactly what an out-of-stock reply is, and it is why it is not a 400.

**201 Created**
The right code when a request has made a new thing. Plain `200` would work, but
`201` tells the caller that something now exists that did not before.

**`finally`**
The checkout button is disabled while the request is in flight, so an impatient
double-click cannot create two orders. It is re-enabled in a `finally` block:

```js
} finally {
  placeOrderButton.disabled = false;
  placeOrderButton.textContent = 'Place order';
}
```

`finally` runs whether we succeeded or failed, so the button can never get stuck
on "Placing your order…". Putting that line in only one of the two paths is a
very easy bug to write.

(And note: disabling a button is *manners*, not a guarantee. A determined person
can still send the request twice. Making the **server** safe against repeats is
a much bigger idea — it is what step 8 is about.)

**Reading the order id from the URL**

```js
const params = new URLSearchParams(window.location.search);
const orderId = params.get('orderId');
```

Built into the browser, so we never chop the text up by hand. But note: that id
came from the URL, so a visitor can change it to any number and look at someone
else's order. In a real shop you would fix that with a login, or with long
unguessable ids (UUIDs) instead of 1, 2, 3. We keep simple numbers because they
are easier to learn with — but this exact shortcut has caused real data breaches.

### ⚠️ What is wrong with `POST /api/orders` (the whole point of step 5)

For a two-watch order the route runs **five separate statements**: insert the
order, insert a line, update stock, insert a line, update stock. Each one is
sent to the database on its own and is saved the instant it succeeds. Nothing
ties them together.

So: what happens if the server crashes, the network drops, or Supabase hiccups
between statement three and statement four?

**Nothing gets undone.** The order exists. One line exists. One watch's stock
has been taken. The second line was never written and its stock was never held.
The customer is charged for a watch that is not on their order, and a watch is
missing from the shelf that nobody bought. Nothing errors. Nothing looks broken.
The numbers are quietly, permanently wrong.

There is a second, subtler problem too. We **check** the stock, and then
**later** we subtract it:

```js
if (watch.quantity < quantity) { ...refuse... }   // check
// ... more statements happen in between ...
await db.query('update stock set quantity = quantity - $1 ...');   // act
```

Two people can both pass the check before either one subtracts. Both are told
yes. The last watch is sold twice. That gap between checking and acting is
called a **race condition**, and step 9 proves it is real.

Step 5 fixes both problems with one idea: a transaction.

### Answers to the Step 4 questions

**Without copying the price** — the old receipt would silently change. Order #1
would stop saying what you paid and start showing today's price. Your records
and the customer's bank statement would disagree, with nothing to explain it.

**If the server dies after statement three** — an order row, *one* item line,
and one watch's stock already taken. The second watch was never recorded and
its stock never held. The customer is billed for something not on their order,
and a watch is missing from the shelf that nobody bought. No error is raised.

**Why both buyers get a yes** — A checks stock (1 left, fine). Before A
subtracts it, B checks too (still 1 left, fine). Both were told yes. The gap
between looking and acting is the bug.

---

## Step 5 — Transactions

### What this step does

`POST /api/orders` now runs inside a database transaction, and takes stock with
a single statement that checks and subtracts at the same moment. Both of Step
4's flaws are gone.

There is also `tests/broken-order-demo.js`, which proves the difference against
your real database.

### What a transaction is

A group of database statements wrapped in **"all of this, or none of it"**.

| | |
| --- | --- |
| `BEGIN` | Start. From here, nothing we write is real to anybody else yet. |
| `COMMIT` | Done. Everything becomes real, together, instantly. |
| `ROLLBACK` | Forget it. Everything since `BEGIN` is discarded — not undone step by step; it was never really written. |

It is a bank transfer. Taking money out of one account and putting it into
another must be one indivisible act. Half of it happening is not "partly a
transfer" — it is money destroyed.

Placing an order has the same shape: create the order, write every line, hold
every watch. **Any subset of that is corruption.**

### The proof, with real numbers

`node tests/broken-order-demo.js` runs the same crash twice. Actual output from
this database:

```
PART 1 - five separate statements, then a crash
  It says the customer owes:        54700 cents
  But its lines only add up to:     29800 cents
  Lines actually written:            1 (there should be 2)
  The customer is billed 24900 cents for a watch that is
  not on their order. Nothing errored. Nothing looks broken.

PART 2 - the same crash, inside a transaction
  Stock of watch 5 is now:  10   (was 10)
  Orders in the table:       1   (was 1)
  Nothing happened. No half-order, no missing stock, no cleanup to write.
```

€249 billed for a watch that was never on the order — and nothing anywhere
reported a problem. That is what "silent corruption" means, and why it is worse
than a crash.

Notice also how fiddly Part 1's cleanup function is. Somebody has to write that,
and keep it correct forever, for every operation. With a transaction, there is
nothing to write.

### `pool.query` vs `pool.connect`

```js
const client = await db.pool.connect();
try {
  await client.query('begin');
  ...
  await client.query('commit');
} finally {
  client.release();
}
```

Everywhere else we use `db.query()`, which borrows any free connection and hands
it straight back — perfect for single queries and **useless** for a transaction.
`BEGIN` on one connection and `COMMIT` on another means nothing.

`pool.connect()` takes one taxi out of the rank and keeps it for the whole
journey. And it must be given back in a `finally`, which runs after success,
after an error, and even after a `return`. Forget `client.release()` and every
failed request keeps a connection forever; the pool empties and the app hangs
waiting for a taxi that is never coming back. Horrible to diagnose, because it
only appears under load.

### The single most important statement in the project

```sql
update stock
   set quantity = quantity - $1,
       updated_at = now()
 where watch_id = $2
   and quantity >= $1
returning quantity
```

The check (`quantity >= $1`) and the action (`quantity - $1`) are in **one
statement**. Postgres locks that row for the instant it takes to run, so nothing
can slip in between.

Compare it with the old code:

```js
if (watch.quantity < quantity) { refuse }        // check
... other statements ...
update stock set quantity = quantity - $1        // act
```

Two customers can both pass that check before either subtracts. Both are told
yes. The last watch is sold twice.

With the single statement there is no gap. Whoever runs second finds
`quantity >= 1` is no longer true, matches **no rows**, and is refused.
`rowCount === 0` is how we detect it.

**Verified live:** with Skyline Pilot at 1, two orders fired at the same instant
gave `201 Created` and `409 Conflict`. Stock went to 0 — never −1.

### Rollback means never writing cleanup code

The best moment in the new route:

```js
if (stockUpdate.rowCount === 0) {
  await safeRollback(client);
  return res.status(409).json({ error: '...' });
}
```

If line three of a five-line order fails, the stock already taken for lines one
and two **comes back on its own**. We never have to remember what we did and
undo it by hand. That is the entire point.

### Deadlocks, and a one-line cure

```js
const items = req.body.items.slice().sort(function (first, second) {
  return Number(first.watchId) - Number(second.watchId);
});
```

This looks pointless. It is not.

Order A wants watches 1 and 3. Order B wants 3 and 1. A locks row 1 and reaches
for row 3; B locks row 3 and reaches for row 1. Each holds what the other needs
and neither can move — a **deadlock**. Postgres notices and kills one, so a
customer gets a random error for no reason.

The cure: everyone always takes the rows in the same order. Like two people
unloading a van who both agree to always pick up the left-hand box first — they
can never end up waiting on each other.

### Why `safeRollback` swallows its own error

If the connection has died, `ROLLBACK` fails too. We do not want that second
failure to hide the first — the original error is the interesting one. So we log
it and move on. (Postgres abandons an unfinished transaction when the connection
closes anyway; this is belt and braces.)

### What does *not* need a transaction

`GET /api/orders/:id` runs two queries with no transaction, and that is correct.
A transaction protects a group of **writes** from being half-applied. There is
nothing here to half-apply.

### Answers to the Step 5 questions

**Why a transaction cannot use `db.query()`** — it grabs *any* free connection
and hands it straight back, so `BEGIN` might go out on connection A and `COMMIT`
on connection B. B has no idea a transaction was started, and A's work dangles.
A transaction is a conversation; you have to stay on the same phone call.

**A five-line order failing on line four** — the stock taken for lines one to
three comes back automatically, because it was never really written. We wrote
**zero** lines of cleanup code to make that happen.

**Why we sort by `watchId`** — so every order grabs the stock rows in the same
order. Otherwise A could hold row 1 while reaching for row 3, and B hold row 3
while reaching for row 1 — each waiting on the other forever.

---

## Step 6 — The simulated payment provider

### What this step does

`pay.html` now has two buttons. Each asks `POST /api/payments/simulate` — our
pretend payment provider — to build an event and **call our shop back over real
HTTP** at `POST /api/webhooks/payment`.

The webhook route exists but is deliberately minimal: it checks the secret and
says "got it". Recording the event and updating the order is Step 7.

### What a webhook is

When you pay with a real provider, your shop does **not** sit and wait for an
answer. Card payments take seconds, need bank checks, sometimes need the
customer to approve something in their banking app. Holding a web request open
that long is hopeless.

So the conversation is turned around. The shop says *"here is a payment to
process, and here is my address"*. Later, the **provider calls the shop back** to
report what happened. That callback is a webhook.

It is the difference between waiting on hold and leaving your number to be rung
back. **A webhook is the ring-back.**

Two things follow, and they are the entire reason Steps 7 and 8 exist:

1. **The call comes from outside**, from a machine we do not control, to a
   public URL with no login and no session. Anyone who finds that URL can call
   it too and claim a payment succeeded.
2. **Providers guarantee "at least once" delivery, not "exactly once".** If
   their call times out, or our server hiccups while replying, they try again.
   The same event genuinely arrives twice.

### The event id — the most important field

```js
const event = {
  eventId: 'evt_' + crypto.randomUUID(),
  type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
  orderId: order.id,
  outcome: outcome,
  amountCents: order.total_cents,
  createdAt: new Date().toISOString(),
};
```

Every event gets a permanent, unique id. If the provider sends this same event
five times, **all five copies carry the same id**. That id is what lets us say
"I have already dealt with this one" and ignore the repeats.

It is the reference number on a letter: receiving three photocopies of the same
letter is not three separate requests.

`crypto.randomUUID()` is built into Node — no package needed. The `evt_` prefix
is purely for human eyes, so you can tell at a glance what kind of id you are
looking at. Step 7 stores it with a `UNIQUE` constraint; Step 8 proves the
duplicate handling works.

### The secret header — and the hole it plugs

```js
function requireWebhookSecret(req, res, next) {
  const providedSecret = req.header('x-webhook-secret');
  if (!providedSecret || providedSecret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret.' });
  }
  next();
}
```

Without this, **anyone** could run:

```bash
curl -X POST https://our-shop/api/webhooks/payment \
     -d '{"orderId":1,"outcome":"success"}'
```

and mark their own order paid without ever paying. This is the single biggest
hole in a naive webhook, and it is a real-world mistake, not a theoretical one.

Real providers do something stronger: a **signature** calculated from the whole
message body plus a secret, so you can also prove the message was not altered
in transit. Same idea, heavier arithmetic. A shared secret teaches the principle
with far less noise.

**Verified live:** a call with no secret and a call with the wrong secret both
got `401`, and the server logged the rejection.

### Working out our own address

```js
const webhookUrl = req.protocol + '://' + req.get('host') + '/api/webhooks/payment';
```

The provider has to call us over real HTTP, so we need a real URL. We build it
from the incoming request rather than hard-coding `http://localhost:3000`,
because the same code has to work on your laptop *and* on Vercel, where the
address is something else entirely.

### What a webhook's reply means

Our reply is not for a human. It is an instruction to the provider:

| Reply | Means |
| --- | --- |
| `200` | Received **and dealt with**. Stop sending this. |
| `4xx` | This event is malformed. Do not bother retrying. |
| `5xx` | I did not handle it. Please send it again later. |

Choosing wrong is how people end up with a provider retrying forever, or worse,
silently losing a payment. Note our `catch` block returns `500` on purpose: an
error on our side must never make a real provider think the payment was handled.

### The order of validation

The secret is checked **first**, before we read a single field of the body.
Then the body shape is validated separately — because even with the right
secret, a genuine provider having a bad day can send you nonsense.

### `fetch` is built in

Node 18 and later have `fetch` with no package to install, which is why our
allowed-packages list stayed at three.

### Answers to the Step 6 questions

**Why not just wait for the result** — a card payment can take seconds or
minutes: bank checks, fraud scoring, sometimes the customer approving it in
their banking app. A request held open that long times out, and if the server
restarts mid-wait the answer is lost. Hanging up and being called back is the
only thing that survives.

**Without the secret check** — a customer could place an order, then run one
`curl` posting `{"orderId":6,"outcome":"success"}` to the public webhook URL,
and their order would be marked paid. Free watch, no payment.

**Why a duplicate is correct behaviour** — the provider sent the event and never
got a clean `200` back. From their side the result is unconfirmed, and losing a
payment notification is far worse than sending one twice, so they retry.
Handling repeats is *our* job.

---

## Step 7 — Processing the webhook

### What this step does

The webhook now does real work, all inside one transaction:

1. records the event in the new `payments` table — and notices if it is a repeat
2. moves the order from `pending` to `paid` or `failed`, **once and only once**
3. puts the held stock back if the payment failed
4. replies in a way the provider will understand

Plus `order.html`, the final confirmation page.

### The idea of the whole step: idempotent

**Idempotent** means *safe to run more than once*. Pressing a lift button twice
does not summon two lifts. Setting a thermostat to 20° twice does not make the
room 40°.

Our webhook must be idempotent, because the provider **will** send the same
event twice. Everything below is in service of that one word.

### The unique constraint is the memory

```sql
event_id text not null unique,
```

Every copy of an event carries the same `event_id`. `unique` means Postgres
*physically cannot* store it twice. The second attempt is refused, and that
refusal is how our code knows "I have seen this one".

We let the **database** remember, not JavaScript. A JavaScript check would be
"look it up, then insert it" — two steps with a gap. Two copies arriving at the
same instant could both look, both find nothing, and both insert. Same race
condition as stock in Step 5, same cure.

### One statement that does the whole duplicate check

```sql
insert into payments (order_id, event_id, outcome)
values ($1, $2, $3)
on conflict (event_id) do nothing
returning id
```

`on conflict ... do nothing` means: try to insert, and if it would break the
unique rule, quietly do nothing instead of raising an error. Combined with
`returning id`, that gives a beautifully simple test:

| Result | Meaning |
| --- | --- |
| got a row back | this event is **new** — carry on |
| got nothing (`rowCount === 0`) | **seen before** — stop, change nothing |

### Business rule four, in one WHERE clause

```sql
update orders
   set status = $1
 where id = $2
   and status = 'pending'
returning id, status
```

Exactly the same trick as the stock update in Step 5. The check (*is it still
pending?*) and the action (*change it*) are one statement, so nothing can slip
in between. If `rowCount` is 0, the order was already paid or failed — perhaps a
different event got there first — and we leave it completely alone.

Note that we still **record** the event even when we do not act on it. The
`payments` table is a log of everything that arrived; the order changes once.

### Giving the stock back

```sql
select watch_id, quantity from order_items
 where order_id = $1 order by watch_id
```

…then `quantity = quantity + $1` for each line. The `order by watch_id` is the
deadlock cure from Step 5 again: everyone touches stock rows in the same order.

**Why this must be in the same transaction as the status change:** imagine them
as separate statements and the server dying in between. The order says `failed`
but the stock never came back — watches missing from the shelf that nobody owns.

### Reply codes are instructions, not decoration

| Reply | What the provider does |
| --- | --- |
| `200` | Dealt with. Stop sending this. |
| `4xx` | Malformed. Do not retry — it will never work. |
| `5xx` | Not handled. Send it again later. |

Three deliberate choices in our route:

- A **duplicate replies `200`**, not an error. An error would make the provider
  try again, and we would loop forever.
- An **unknown order replies `404`**, so the provider gives up. That event will
  never succeed however many times it is sent.
- Any **unexpected failure replies `500`**, so a real provider retries. A fault
  on our side must never silently lose a payment — and because the route is
  idempotent, that retry is safe.

### Verified live

With the `payments` table not yet created, a valid event produced a clean `500`,
the transaction rolled back, and order #6 was still `pending` afterwards. The
transaction protected us from a half-processed payment even during a failure we
had not planned for. Secret and body checks all behaved: `401` twice, `400`
twice, `404` for a missing order.

### Answers to the Step 7 questions

**Why a duplicate gets `200`** — `200` means "dealt with, stop sending this". An
error would tell the provider we failed, so it would send the event again, and
again, forever. Nothing went wrong, so we must not say it did.

**If status change and stock return were separate** — the server could die
between them. The order would say `failed` while the stock stayed held. Watches
missing from the shelf that nobody owns and no order claims, with nothing to
report it.

**Why log an event we do not act on** — `payments` is a record of everything the
provider told us, not just what we acted on. When a customer disputes a charge
you need to say "on the 3rd we were told success, on the 5th failed, and here is
why the order stayed as it was". Discarding messages destroys the audit trail
exactly when you need it.

---

## Step 8 — Proving the webhook is idempotent

### What this step does

`tests/duplicate-webhook.js` fires the same payment event at the shop repeatedly
and checks — against the real database — that the shop changes exactly once.

```
node tests/duplicate-webhook.js     (with `npm start` running in another terminal)
```

Result: **21 passed, 0 failed.**

### The three situations it tests

**Part 1 — the same event twice, one after the other.** The everyday case: the
provider's first call worked, but our reply got lost, so from their side it
failed and they retry a minute later.

```
First delivery  -> 200 "Order 8 is now failed."
Second delivery -> 200 "This event was already processed. Nothing changed."
```

The critical check is not the status — it is the **stock**. If the duplicate had
been processed, the two held watches would have gone back on the shelf a *second*
time and the shop would own two watches that never existed.

**Part 2 — a different event, arriving late and saying the opposite.** Not a
duplicate: a new id, saying `success` for an order already marked `failed`.
Business rule four says a finished order is never changed again, so the event is
**recorded** for the audit trail and the order is **left alone**.

**Part 3 — the same event twice at the exact same instant.** The hard case, and
the reason we used a unique constraint rather than a check in JavaScript.

```js
const [first, second] = await Promise.all([sendEvent(event), sendEvent(event)]);
```

`Promise.all` starts both without waiting, so they are genuinely in flight
together. We cannot know which one wins — and we do not care. What matters is
that **exactly one** did the work:

```js
check('exactly one was treated as the duplicate', duplicateFlags, [false, true]);
```

### Writing a test with no test framework

Two functions and a counter:

```js
function check(description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log('  PASS  ' + description); }
  else { failed++; console.log('  FAIL  ' + description); ... }
}
```

`JSON.stringify` lets one line compare numbers, strings and small objects.
At the end, `process.exit(failed === 0 ? 0 : 1)` — exit code 0 means success,
1 means failure. That convention is what every build tool and CI system reads.

The test also **cleans up in a `finally` block**, so even a crashed test never
leaves your shop in a strange state.

### The most important thing about this step

**A test you have never seen fail is not a test.** It might be checking nothing
at all and you would never know.

So the guards were deliberately sabotaged and the test re-run: the duplicate
short-circuit was disabled, and `and status = 'pending'` was removed from the
order update. The test immediately reported **6 failures**, including:

```
FAIL  the stock went back exactly once
      expected: 12
      actually: 13
FAIL  the order is still failed
      expected: "failed"
      actually: "paid"
```

Stock 13 where it should be 12 — **a watch invented out of thin air** by one
duplicate message. And an order that had already failed flipping to paid.

The code was then restored (verified by checksum) and the test passed 21/21
again. Now we know the test can actually catch the bug it claims to prevent.

### Two guards, not one

Notice that sabotaging *one* guard was not enough to break everything. The
unique `event_id` and the `and status = 'pending'` clause each block duplicates
independently — the same **defence in depth** idea as the stock check
constraint in Step 1. The more expensive the mistake, the more independent
layers should have to fail before it happens.

### Answers to the Step 8 questions

**Why stock is more revealing than status** — setting an order to `failed` twice
leaves it `failed`, so the status looks fine even when the duplicate *was*
processed. It hides the bug. Adding 2 back twice gives you 2 watches that never
existed. The status is idempotent by accident; the stock is where damage shows.

**What `Promise.all` changes** — two `await`s on separate lines means the first
request finishes before the second starts, so there is no race to test.
`Promise.all` starts both without waiting, so they are genuinely in flight
together.

**Why break the code on purpose** — a test that has never failed might be
checking nothing at all, and you would never know.

---

## Step 9 — Proving the shop cannot oversell

### What this step does

`tests/last-watch-race.js` makes several people reach for the last Skyline Pilot
at the same instant and proves exactly one gets it.

```
node tests/last-watch-race.js     (with `npm start` running in another terminal)
```

Result: **13 passed, 0 failed.**

### What a race condition is

A bug where the result depends on the exact timing of two things happening at
once — so it works perfectly every time you try it by hand, and then goes wrong
on a busy Friday.

The classic shape is **check, then act**:

```js
if (there is enough stock) {      // check
    take the stock                // act
}
```

Between the check and the act there is a gap. Another customer can slip into
that gap, pass the same check, and act too. Both were honestly told "yes".

It is two people reaching for the last item on a shelf. Whether it goes wrong
depends on whose hand arrives first, measured in milliseconds — which is why you
cannot find these bugs by clicking around.

### Part 1 — two buyers, one watch

```
Anna -> 201 "order #14"
Ben  -> 409 "Not enough stock for Skyline Pilot. Only 0 left."
```

We do not know or care *which* one wins — that is genuinely down to
microseconds. So the test sorts the two status codes and checks the pair:

```js
check('one was created and one was refused', statuses, [201, 409]);
```

Writing an assertion that does not depend on timing is a real skill. "Anna wins"
would be a flaky test; "exactly one wins" is a true one.

### Part 2 — ten buyers, three watches

A two-way race is small enough to pass by luck. Ten at once is not.

```
  created (201): 3
  refused (409): 7
  anything else: 0
```

That last line matters as much as the others. Nobody should get a `500`, a
deadlock error or a timeout. **Losing politely is part of working correctly.**

### Part 3 — watching the old code lose

This part bypasses our route and runs the Step 4 "check, then act" logic by hand
on two connections, so you can *see* the bug:

```
Anna checks the shelf and sees: 1
Ben checks the shelf and sees:  1

Anna's code decides: YES, there is one
Ben's code decides:  YES, there is one
```

Both customers were promised the same watch. Then:

```
Anna took it and committed. Stock is now 0.
Ben's update was REJECTED by the database:
  "new row for relation "stock" violates check constraint "stock_quantity_check""
```

Read that carefully. **The code sold the watch twice.** The only thing that
stopped an actual oversell was `check (quantity >= 0)` — written back in Step 1,
for exactly this reason, long before we knew what a race condition was.

And the customer it saved got an ugly database error instead of the polite
"Not enough stock" from Part 1. Remove that constraint and the shop would have
happily sold a watch it did not own.

This is **defence in depth** paying off in front of you: the application logic
failed, and a rule in the database caught it.

### The entire fix, one line

```sql
update stock set quantity = quantity - $1
 where watch_id = $2 and quantity >= $1
```

Moving the check *inside* the update closes the gap. Postgres locks the row for
the instant the statement runs, so nothing can slip in. Whoever runs second
matches no rows, and `rowCount === 0` tells us to refuse politely.

### Verified by sabotage, again

`and quantity >= $1` was removed from `routes/orders.js` and the test re-run:

```
Anna -> 201 "order #18"
Ben  -> 500 "Could not create the order."

FAIL  one was created and one was refused
      expected: [201,409]   actually: [201,500]
FAIL  nobody got an unexpected error
      expected: 0           actually: 7
```

Notice what did **not** fail: `stock never went negative` still passed. The
Step 1 constraint was still protecting the data. But seven customers got a
meaningless `500` instead of a clear explanation — the data was safe and the
shop was broken.

Two different things, both needed. The code was then restored (checksum
verified) and both test suites pass again.

### Answers to the Step 9 questions

**Why `[201, 409]` rather than "Anna wins"** — who wins is down to microseconds
and changes run to run. A test asserting "Anna wins" would pass sometimes and
fail sometimes for no reason — a *flaky* test, which is worse than no test,
because you learn to ignore it.

**What stopped the oversell in Part 3** — not the code. The code told both
buyers yes. It was `check (quantity >= 0)` on the stock table, written in Step 1.
The database refused a write the application was perfectly willing to make.

**Was the sabotage harmless?** No. The data stayed correct, but seven customers
got a meaningless `500` instead of "Not enough stock". A shop that cannot
explain why it will not sell you something is broken, even if its numbers add
up. Safe data and a working shop are two different things.

---

## Step 10 — The whole thing, end to end

### The two journeys, verified

**Successful purchase** — browse → add to cart → place order → pay → confirmation

| Stage | What was observed |
| --- | --- |
| Shop | Six cards; Skyline Pilot "Only 1 left"; Pulse Smart sold out, button disabled |
| Cart | €249.00 + €279.00 = **€528.00**, cart badge showing 2 |
| Place order | Order #28 created, **cart emptied**, redirected to `pay.html` |
| Pay | "The shop received the event and marked order #28 as **paid**" |
| Stock | Harbour Diver 8 → 7, Skyline Pilot 1 → 0 — **stays held**, because it was sold |
| Confirmation | Green ✅ "Payment received" |

**Failed payment** — same, until the payment fails

| Stage | What was observed |
| --- | --- |
| Order | #30, 3 × Apex Chrono, €987.00 |
| Stock while held | Apex Chrono 3 → **0** |
| Webhook | `Order 30 is now failed`, `stockReturned: [{watchId: 3, quantity: 3}]` |
| Stock after | Apex Chrono back to **3** — on the shelf for someone else |
| Confirmation | Amber ⚠️ "Payment failed", with a route back to the shop |

The difference between those two stock columns is the whole project in one
line. **Paid: the stock stays gone. Failed: the stock comes back.** Automatically,
inside a transaction, with no cleanup code anywhere.

### Two rough edges found and fixed while walking through

Walking a flow end to end finds things unit tests never will.

**A dead end.** Opening `pay.html` for an order that was already paid hid the
whole payment card, leaving a page with no way onwards. Now it shows *"This
order has already been paid. It cannot be paid again"* and a link to the order.

**A stale badge.** After paying, the badge at the top still read "Awaiting
payment" directly above a message saying the order was paid. A small thing that
makes a page feel broken. It now refreshes in place — just the badge, so the
event panel stays on screen to read.

### The reset script

```bash
npm run reset
```

`tests/reset-shop.js` deletes every order and puts the six watches back to their
seeded quantities, all in one transaction — because a shop with no orders but
the old stock numbers would be worse than not resetting at all.

It looks watches up **by name**, not by id, so it still works if you ever re-run
`sql/01` and Postgres hands out different id numbers.

Deleting the orders removes their `order_items` and `payments` rows too, because
both foreign keys were declared `on delete cascade` — one `delete` statement
cleans up three tables.

### All the commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the shop at http://localhost:3000 |
| `npm run reset` | Put the shop back to opening day |
| `npm run test:transaction` | Show why the order route needs a transaction |
| `npm run test:duplicate` | 21 checks — the webhook is idempotent |
| `npm run test:race` | 13 checks — the shop cannot oversell |

Final state: **34 checks passing.**

### The three security holes, and what closed each one

| Risk | What closes it |
| --- | --- |
| Price tampering in the browser | The server reads every price from the database; the cart stores only ids and quantities |
| Forged webhook calls | The `x-webhook-secret` header; wrong or missing → `401` |
| Customers changing stock | Staff routes require the `x-staff-key` header |
| SQL injection | Every query is parameterised (`$1`, `$2`) — values are never glued into SQL |
| Injected HTML (XSS) | `escapeHtml()` before any text goes into the page |

### What to do differently in a real shop

Worth writing down, because a portfolio project should be honest about its
shortcuts:

- **Order ids are 1, 2, 3.** Anyone can change the number in the URL and read
  someone else's order. Real shops use a login, or long unguessable ids (UUIDs).
- **The staff key is a shared password.** A real shop needs user accounts,
  hashed passwords, sessions, and a role on each account.
- **The webhook uses a shared secret.** Real providers send a *signature* over
  the whole message body, which also proves the message was not altered.
- **Held stock is never released.** If a customer never pays, their order sits
  `pending` forever and the watches are held forever. Real shops expire
  abandoned orders after 15–30 minutes with a scheduled job.
- **No emails, no shipping, no refunds, no tax.** Deliberately out of scope.

---

## Glossary

Every term this project introduced, in one place.

| Term | In one sentence |
| --- | --- |
| **Connection pool** | A handful of database connections kept open and reused, like a taxi rank, instead of building a new one per request. |
| **Parameterised query** | Writing `$1` and passing the value separately, so the database treats it as data and never as instructions. |
| **SQL injection** | An attack where a visitor types SQL into a form field and the database runs it — prevented by parameterised queries. |
| **Foreign key** | A rule that a column must point at a real row in another table. |
| **Cascade delete** | "If the parent row goes, delete these children too." |
| **Check constraint** | A rule the database will not break no matter what code asks it to. |
| **Index** | A pre-sorted lookup, like the index at the back of a book, so the database can jump instead of reading everything. |
| **One-to-many** | One row (an order) with many rows pointing back at it (its items). |
| **JOIN** | Gluing rows from two tables together using something they share. |
| **Middleware** | A function Express runs on every request before it reaches the route — airport security. |
| **Transaction** | A group of statements wrapped in "all of this, or none of it". |
| **`BEGIN` / `COMMIT` / `ROLLBACK`** | Start / make it all real / throw it all away. |
| **Race condition** | A bug whose result depends on the exact timing of two things happening at once. |
| **Check-then-act** | The shape that causes race conditions: look, then do, with a gap in between. |
| **Deadlock** | Two transactions each holding what the other needs; cured by always taking rows in the same order. |
| **Webhook** | A callback from an outside service to a public URL of ours — the ring-back after leaving your number. |
| **Idempotent** | Safe to run more than once; pressing the lift button twice does not summon two lifts. |
| **`on conflict do nothing`** | Insert this row, and if it would break a unique rule, quietly do nothing. |
| **Event id** | The permanent unique reference on an event, so repeats can be recognised and ignored. |
| **Defence in depth** | Guarding something important in several independent places, so one failure is not enough. |
| **XSS** | Injecting HTML or script into a page through text that was not escaped. |
| **`localStorage`** | A box of text the browser keeps on the visitor's own computer — which means they can edit it. |
| **Event delegation** | One listener on a container instead of one per child, so it works for elements created later. |
| **Flaky test** | A test that passes sometimes and fails sometimes for no real reason — worse than no test. |

---

## The one-sentence version

**Hold the stock when the order is created, wrap every group of related writes
in a transaction, make the check and the action a single statement, and give
every event a unique id so you can safely ignore the second copy.**

Everything else in this project is detail.
