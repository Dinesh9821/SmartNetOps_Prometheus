# Auth, activity log, and admin — what needs to change

This is a **plan only**. It describes the work to move accounts and operator activity out of the browser and into PostgreSQL so Admin can see sign-ins, account creation, and per-user history for a year or longer.

Do not treat this as already implemented. Today none of this lives in a real database.

---

## 1. Goal

When an operator:

- creates an account
- signs in
- picks region / country / site on the landing page
- opens a module
- runs a workflow or makes a change

…that event is stored on the **server**, for **all users**, for a **long time**.

Admin (only) can:

- see who signed in or created an account **today** (and any other date)
- click a user and see **what they did** (scope, modules, actions)
- filter that timeline by **any date** (past year or more)

---

## 2. What exists today (the problem)

| Piece | Where it lives now | Limit |
|---|---|---|
| Accounts | `index.html` → `localStorage.userRecords` | Only that browser |
| Passwords | Plain text in localStorage | Unsafe |
| Admin flag | `localStorage.isAdmin` if username is `Admin` | Easy to fake |
| Activity | `activity-tracker.js` → `localStorage.netops_activity_logs` | Max **1000** events, same browser only |
| Admin UI | `admin.html` reads those local logs | Another PC sees nothing |
| Site scope | `selectedRegion`, `selectedCountry`, `selectedSite` in localStorage | Not a durable audit |

So Admin cannot see company-wide sign-ins, and history cannot last a year.

---

## 3. Database choice

**Use PostgreSQL.**

| | SQLite | PostgreSQL |
|---|---|---|
| Setup | One file, no extra service | Install Postgres (or use an existing instance) |
| Many users writing at once | Weak | Strong |
| Admin query: “this user, 14 Mar last year” | Possible, painful at scale | Normal with indexes |
| 1+ year of logs | File grows, write locks | Designed for this |

SQLite is only for a laptop demo. This hub is an operations tool with unbounded users and long retention. **PostgreSQL** is the language/database to use.

Suggested first setup: Postgres on the same host as the Express proxy (`localhost:5432`), database name e.g. `smartnetops`.

Stack stays **Node + Express** (`proxy-server/`). No second backend language required.

---

## 4. Target architecture

```
Browser (HTML pages)
    │  POST /api/auth/signup, /login
    │  POST /api/activity
    │  GET  /api/admin/...   (admin session only)
    ▼
Express proxy-server (port 8080)
    │  hash passwords, session cookie
    │  write/read SQL
    ▼
PostgreSQL
    users
    auth_events
    activity_events
```

Prometheus and the existing `/proxy`, `/proxy1`… `/proxy7` routes stay as they are. This work **adds** auth + audit next to them.

---

## 5. Tables to add

### 5.1 `users`

Who is allowed in.

| Column | Purpose |
|---|---|
| `id` | UUID or bigserial |
| `username` | Unique, 3–20 chars (same rules as login page) |
| `password_hash` | bcrypt/argon2 — **never** store the raw password |
| `role` | `operator` or `admin` |
| `is_active` | Disable without deleting history |
| `created_at` | Account created |
| `last_login_at` | Last successful sign-in |

Seed **one** admin in the database (not “whoever types Admin in localStorage”).

### 5.2 `auth_events`

Sign-ins and account creation (admin “today” list).

| Column | Purpose |
|---|---|
| `id` | Primary key |
| `user_id` | FK → users |
| `event_type` | `signup` \| `login` \| `logout` \| `password_reset` |
| `occurred_at` | Timestamp (UTC) |
| `ip` | Optional |
| `user_agent` | Optional |

**Index:** `(occurred_at)`, `(user_id, occurred_at)`.

### 5.3 `activity_events`

What the operator did after login.

| Column | Purpose |
|---|---|
| `id` | Primary key |
| `user_id` | FK → users |
| `occurred_at` | Timestamp (UTC) |
| `module` | e.g. `landing`, `dashboard`, `monitoring`, `NetAutomation Flow` |
| `action` | `page_view` \| `region_select` \| `country_select` \| `site_select` \| `module_open` \| `workflow_run` \| `site_info_update` \| … |
| `region` | Snapshot at that moment (nullable) |
| `country` | Snapshot (nullable) |
| `site_id` | Snapshot (nullable) |
| `details` | JSONB for extras (workflow name, ticket number, fields changed) — **small**, not full API dumps |

**Indexes:** `(user_id, occurred_at DESC)`, `(occurred_at)`, maybe `(module)`.

Do **not** cap at 1000 rows. Keep at least 1–2 years; archive later if needed.

---

## 6. APIs to add on the proxy

All JSON. Session via **httpOnly cookie** (preferred) or a signed token. Do not trust `localStorage.isAdmin`.

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/api/auth/signup` | Anyone | Create user, write `auth_events.signup` |
| POST | `/api/auth/login` | Anyone | Check hash, set session, write `auth_events.login` |
| POST | `/api/auth/logout` | Signed-in | Clear session, optional logout event |
| POST | `/api/auth/reset` | Decide policy | Today anyone with a username can reset; **tighten this** (admin-only or email). Do not copy the current “anyone can change any password” behaviour into the DB. |
| GET | `/api/auth/me` | Signed-in | Current user + role |
| POST | `/api/activity` | Signed-in | Insert one `activity_events` row |
| GET | `/api/admin/auth-events` | Admin | Sign-ins / signups, query `?from=&to=` (default: today) |
| GET | `/api/admin/users` | Admin | User list |
| GET | `/api/admin/users/:id/activity` | Admin | Timeline, query `?from=&to=` |

Admin routes must **401/403** if the session is missing or role is not `admin`.

---

## 7. File-by-file changes

### Backend (new + existing)

| File | Change |
|---|---|
| `proxy-server/package.json` | Add `pg` (Postgres client) and a password hasher (`bcrypt` or `argon2`) |
| **New** `proxy-server/.env` or config | `DATABASE_URL`, session secret — **do not commit secrets** |
| **New** `proxy-server/db.js` | Pool connection to Postgres |
| **New** `proxy-server/schema.sql` | CREATE TABLE + indexes |
| **New** `proxy-server/authService.js` | Signup, login, session, hash |
| **New** `proxy-server/activityService.js` | Insert + admin queries |
| `proxy-server/server.js` | Register the routes above; keep existing `/proxy*` and `/api/dashboard` |

### Frontend — must change

| File | Change |
|---|---|
| `index.html` | Create account / sign-in / reset call the new APIs. Stop writing `userRecords` as source of truth. Stop saving `rememberedPassword`. After login, keep a session cookie; optional: still set `currentUser` for display only. Redirect Admin using **server role**, not username string. |
| `activity-tracker.js` | After each `addLog`, `POST /api/activity`. Keep localStorage only as a fallback if the network is down (optional). Remove the 1000-cap for the **server** copy. Drop noisy `console.log` while touching this file. |
| `admin.html` | Stop reading `ActivityTracker.getAllLogs()`. Load `/api/admin/auth-events` for the day. Click user → `/api/admin/users/:id/activity` with a **date picker**. Require admin session; redirect others to login. Apply `theme.css` more consistently if desired. |
| `landing page.html` | Already calls `trackRegionSelection` / country / site / module. Those must hit the server once `activity-tracker.js` is wired. No extra UI needed for logging. |
| `theme.js` | Sign out already clears `currentUser`. Also call `/api/auth/logout`. |

### Frontend — log real “changes”, not only page views

`ActivityTracker.trackTask(...)` is already defined. Call it from modules that **change something**, for example:

| Page | Log when |
|---|---|
| `Netautomation Flow.html` | Workflow run (name + site) |
| `site-info-update.html` | Save / update |
| `server-automation-flow.html` / `cloud-automation-flow.html` | Run |
| `path-analysis-flow.html` | Run path analysis |
| `circuit-diversity.html` | Run analysis |
| `firewall.html` | Rule / request actions |
| `chatops.html` / `netchatops.html` | Send message (do **not** store full LLM transcripts unless required) |
| `logicmonitor.html` | Suppress / add / remove operations |
| `request-incident-analysis.html` | Run analysis (ticket type + number) |
| `dashboard.html` / `monitoring.html` | Optional: page_view + site only |

Do **not** store huge payloads (full PromQL results, PNG diagrams, ChatOps walls of text) in `details`. Store identifiers and short summaries.

---

## 8. Admin experience (target)

1. Admin signs in with an **admin** account.
2. Lands on `admin.html`.
3. **Today (default):** table of logins and new accounts (username, time, event type).
4. Date filter: any day or range (last 7 days, last year, custom).
5. Click a username:
   - profile header (created, last login, role)
   - timeline: time, module, action, region, country, site, short details
6. That data comes from Postgres, so it is the same on every machine.

---

## 9. Security (do not skip)

- Hash passwords. Current login stores them in plain text; **do not copy that into Postgres**.
- Session cookie: `httpOnly`, `SameSite`, secure when on HTTPS.
- Admin APIs check role on the **server**.
- Stop persisting passwords in `rememberedPassword`.
- Tighten “Forgot password”: anyone who knows a username can set a new password today. That must not remain once accounts are global.
- Do not log passwords, Authorization headers, or full ChatOps/LLM bodies.
- Existing proxy routes still contain hardcoded Basic auth to internal APIs; that is a **separate** cleanup, not this feature.

---

## 10. Suggested build order

1. Install PostgreSQL, create DB, run `schema.sql`.
2. Add `db.js` + auth APIs; migrate `index.html` signup/login.
3. Seed one admin user.
4. Point `activity-tracker.js` at `POST /api/activity`.
5. Rebuild `admin.html` against admin APIs + date filter.
6. Add `trackTask` on automation / update pages.
7. Remove localStorage as the system of record (keep only UI helpers: last selected site for convenience).

---

## 11. Out of scope (this work)

- Changing Aurora theme
- Prometheus / dashboard / monitoring APIs
- Fixing mixed proxy hosts (`localhost` vs `cussya5w` vs `161.145…`)
- Adding `/proxy5` and `/proxy6` (referenced by NetAutomation Flow but missing in `server.js`)

---

## 12. Done when

- Creating an account on PC A is visible to Admin on PC B.
- Sign-ins for a given date list real users from the database.
- Clicking a user shows region, country, site, modules, and actions for that date (and older dates).
- History is not wiped if someone clears the browser, and is not capped at 1000 events.
- Passwords are hashed; only `role = admin` can open admin APIs.
