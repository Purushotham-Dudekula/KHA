# KH Backend

Node.js + Express + MongoDB API for agriconnect bookings, users, payments, and admin tools.

**Run:** `npm run dev` (development) · `npm start` (production)  
**Tests:** `npm test` (from the project root)

**Requirements:** Node.js **20+**, MongoDB (local or Atlas), `.env` (copy from `.env.example`).

### Operations & incidents

- **`RUNBOOK.md`** — What it means: a **short incident playbook** for production (stuck payments, webhooks, Redis/BullMQ, reconciliation). It is **not** setup documentation; use **`README.md`** + **`.env.example`** for that.

---

## Environment variables

Configuration is validated in `src/config/env.js`.

### Always required (any `NODE_ENV`)

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `development` or `production` |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Signing key for user/admin JWTs |
| `JWT_EXPIRES_IN` | JWT lifetime (e.g. `7d`, `15m`) |
| `CORS_ORIGIN` | Comma-separated allowed browser origins (no `*`) |

### Required only when `NODE_ENV=development`

| Variable | Purpose |
|----------|---------|
| `DEV_ROUTE_SECRET` | Secret for dev-only routes / `x-dev-secret` header |

### Required when `NODE_ENV=production`

Atlas-style `MONGO_URI` (`mongodb+srv` or host containing `mongodb.net`), plus **Razorpay**, **MSG91**, **SMTP**, **Redis**, and **storage** (S3 or Cloudinary)—see `assertProductionIntegrationEnv()` in `src/config/env.js` and the full list in **`.env.example`**.

### Strongly recommended (local + production)

| Variable | Purpose |
|----------|---------|
| `REDIS_URL` | BullMQ queues (webhooks, payments, notifications); without it, workers do not run and jobs may run inline in development |
| `RAZORPAY_WEBHOOK_SECRET` | Verifies `POST /api/webhooks/razorpay` |

### Optional

| Variable | Purpose |
|----------|---------|
| `ENABLE_SECURITY_HARDENING` | Default `true`; request sanitization |
| `ENABLE_SOCKET_IO_REDIS` | `true`/`false`; Redis adapter for Socket.IO multi-instance |
| `SENTRY_DSN` | Error tracking |
| `GOOGLE_MAPS_API_KEY` | Distance/duration; else Haversine fallback |

---

## Local development & Postman

1. **Start MongoDB** locally (or point `MONGO_URI` at Atlas).
2. Copy **`.env.example`** → **`.env`** and set at least the **required** variables above.
3. **Install & run:** `npm install` then `npm run dev` or `npm start`.
4. **Smoke test:** open `GET http://localhost:<PORT>/api/health` (default port **5000** from `PORT` or `env.port`).

If the server exits immediately, check the error: missing `MONGO_URI` / `JWT_SECRET`, invalid `CORS_ORIGIN`, or **production** validation failing because `NODE_ENV` is accidentally set to `production` without full integration env.

**Postman:** use the same base URL; for protected routes send `Authorization: Bearer <token>` from `POST /api/auth/verify-otp` (or your auth flow). Webhooks need raw JSON body and header `x-razorpay-signature` (see `src/controllers/razorpayWebhook.controller.js`).

### Localhost not working?

| Symptom | Likely cause | What to do |
|--------|----------------|------------|
| `MongoDB connection failed: connect ECONNREFUSED 127.0.0.1:27017` | MongoDB is not running locally, or `MONGO_URI` points to the wrong host | Start `mongod` / MongoDB service, or set `MONGO_URI` to a running instance (e.g. MongoDB Atlas). |
| `Missing required environment variable` on startup | Incomplete `.env` | Copy `.env.example`, set all **required** vars for your `NODE_ENV`. |
| `Production requires…` while developing | `NODE_ENV` is `production` without full integration secrets | Use `NODE_ENV=development` locally, or supply all production variables from `src/config/env.js`. |
| Queue/webhook delays in dev | No `REDIS_URL` | Optional in development; workers may not run—see logs. Set `REDIS_URL` for full BullMQ behavior. |

---

## API Routes Reference

> Interactive docs available at: GET /api-docs

All routes below are mounted under `/api/v1` unless explicitly noted.

### Auth

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| POST | /api/v1/auth/send-otp | No | Public | Send OTP to phone |
| POST | /api/v1/auth/verify-otp | No | Public | Verify OTP and login |
| POST | /api/v1/auth/refresh | No | Public | Refresh access token |
| POST | /api/v1/auth/refresh-token | No | Public | Backward-compatible refresh alias |
| POST | /api/v1/auth/logout | Yes | Any user | Logout current user |

### User / Farmer

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| GET | /api/v1/user/me | Yes | Any user | Get current user profile |
| POST | /api/v1/user/select-role | Yes | Any user | Select farmer/operator role |
| POST | /api/v1/user/profile/farmer | Yes | Farmer | Update farmer profile |
| POST | /api/v1/user/profile/operator | Yes | Operator | Update operator profile basics |
| PATCH | /api/v1/user/profile/operator/documents | Yes | Operator | Upload operator KYC documents |
| PATCH | /api/v1/user/location | Yes | Any user | Update current location |
| PATCH | /api/v1/user/status | Yes | Any user | Update online/offline status |
| PATCH | /api/v1/user/language | Yes | Any user | Update preferred language |
| POST | /api/v1/user/fcm-token | Yes | Any user | Save device FCM token |
| GET | /api/v1/user/dashboard | Yes | Farmer | Get farmer dashboard |
| GET | /api/v1/user/nearby-operators | Yes | Farmer | List nearby operators |
| GET | /api/v1/user/operators/:operatorId | Yes | Any user | Get public operator profile |

### Operator

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| GET | /api/v1/operator/earnings | Yes | Operator | Get operator earnings summary |
| GET | /api/v1/operator/earnings-history | Yes | Operator | Get operator earnings history |
| GET | /api/v1/operator/my-bookings | Yes | Operator | List operator booking history |
| POST | /api/v1/operator/location | Yes | Operator | Update operator location |
| PATCH | /api/v1/operator/bank-details | Yes | Operator | Update operator payout details |

### Tractor

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| POST | /api/v1/tractor | Yes | Operator | Create tractor |
| GET | /api/v1/tractor | Yes | Operator | List own tractors |
| GET | /api/v1/tractor/my-tractors | Yes | Operator | Alias for own tractors list |
| GET | /api/v1/tractor/details/:id | Yes | Any user | Get tractor details |
| GET | /api/v1/tractor/:id | Yes | Any user | Backward-compatible tractor details alias |
| DELETE | /api/v1/tractor/:id | Yes | Operator | Delete own tractor |
| PATCH | /api/v1/tractor/:id/documents | Yes | Operator | Upload tractor documents/photos |
| PATCH | /api/v1/tractor/:id/availability | Yes | Operator | Set tractor availability |
| PATCH | /api/v1/tractor/:id | Yes | Operator | Update tractor basics |
| PATCH | /api/v1/tractor/:tractorId/verification | Yes | Admin | Verify/reject tractor from admin flow |

### Booking

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| POST | /api/v1/bookings/create | Yes | Farmer | Create booking request |
| POST | /api/v1/bookings/estimate | Yes | Farmer | Estimate booking amount |
| GET | /api/v1/bookings/farmer | Yes | Farmer | List farmer bookings grouped by state |
| GET | /api/v1/bookings/operator | Yes | Operator | List operator bookings grouped by state |
| POST | /api/v1/bookings/:id/review | Yes | Farmer | Submit booking review |
| GET | /api/v1/bookings/:id/track | Yes | Farmer | Track operator location/ETA |
| GET | /api/v1/bookings/my-bookings | Yes | Farmer | List farmer booking history |
| GET | /api/v1/bookings/:id/refund-preview | Yes | Farmer/Operator | Preview refund and penalty snapshot |
| GET | /api/v1/bookings/:id | Yes | Farmer/Operator | Get booking details |
| GET | /api/v1/bookings/:id/invoice | Yes | Farmer/Operator | Get or download booking invoice |
| PATCH | /api/v1/bookings/:id/progress | Yes | Operator | Update in-progress job progress |
| POST | /api/v1/bookings/:id/cancel | Yes | Farmer/Operator | Cancel booking with policy checks |
| PATCH | /api/v1/bookings/:id/start | Yes | Operator | Start job lifecycle |
| PATCH | /api/v1/bookings/:id/complete | Yes | Operator | Complete job and mark balance due |
| POST | /api/v1/bookings/:id/respond | Yes | Operator | Accept or reject pending booking |

### Payment

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| POST | /api/v1/bookings/:id/pay-advance | Yes | Farmer | Record advance payment intent |
| POST | /api/v1/bookings/:id/pay-remaining | Yes | Farmer | Record remaining payment intent |
| GET | /api/v1/payments/my | Yes | Any user | List authenticated user payments |

### Webhooks

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| POST | /api/v1/webhooks/razorpay | No (signature-verified) | Razorpay | Handle payment webhook events |

### Admin

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| POST | /api/v1/admin/login | No | Admin | Admin login |
| POST | /api/v1/admin/forgot-password | No | Admin | Request admin password reset OTP |
| POST | /api/v1/admin/verify-otp | No | Admin | Verify admin OTP |
| POST | /api/v1/admin/reset-password | No | Admin | Reset admin password |
| GET | /api/v1/admin/me | Yes | Admin | Get admin profile |
| GET | /api/v1/admin/tractors/pending | Yes | Admin | List pending tractors |
| GET | /api/v1/admin/live-bookings | Yes | Admin | List live bookings |
| PATCH | /api/v1/admin/verify-operator/:id | Yes | Admin | Approve operator |
| PATCH | /api/v1/admin/reject-operator/:id | Yes | Admin | Reject operator with reason |
| PATCH | /api/v1/admin/verify-tractor/:id | Yes | Admin | Approve tractor |
| PATCH | /api/v1/admin/reject-tractor/:id | Yes | Admin | Reject tractor with reason |
| GET | /api/v1/admin/users | Yes | Admin | List users |
| GET | /api/v1/admin/bookings | Yes | Admin | List bookings |
| PATCH | /api/v1/admin/block-user/:id | Yes | Admin | Block or unblock user |
| GET | /api/v1/admin/audit-logs | Yes | Admin | List admin audit logs |
| GET | /api/v1/admin/complaints | Yes | Admin | List complaints |
| PATCH | /api/v1/admin/complaints/:id/respond | Yes | Admin | Respond to complaint |
| GET | /api/v1/admin/dashboard | Yes | Admin | Dashboard summary |
| GET | /api/v1/admin/dashboard/bookings | Yes | Admin | Booking analytics |
| GET | /api/v1/admin/dashboard/revenue | Yes | Admin | Revenue analytics |
| GET | /api/v1/admin/dashboard/users | Yes | Admin | User analytics |
| GET | /api/v1/admin/revenue | Yes | Admin | Revenue report endpoint |
| GET | /api/v1/admin/demand-analytics | Yes | Admin | Demand analytics |
| POST | /api/v1/admin/notifications/broadcast | Yes | Admin | Broadcast notification |
| POST | /api/v1/admin/refunds/:bookingId | Yes | Admin | Process refund decision |
| POST | /api/v1/admin/pricing | Yes | Admin | Upsert base pricing |
| GET | /api/v1/admin/pricing | Yes | Admin | List pricing |
| POST | /api/v1/admin/seasonal-pricing | Yes | Admin | Upsert seasonal pricing |
| GET | /api/v1/admin/seasonal-pricing | Yes | Admin | List seasonal pricing |
| DELETE | /api/v1/admin/seasonal-pricing/:id | Yes | Admin | Delete seasonal pricing |
| POST | /api/v1/admin/commission | Yes | Admin | Upsert commission |
| GET | /api/v1/admin/commission | Yes | Admin | Get active commission |
| POST | /api/v1/admin/offers | Yes | Admin | Create offer |
| PATCH | /api/v1/admin/offers/:id | Yes | Admin | Update offer |
| DELETE | /api/v1/admin/offers/:id | Yes | Admin | Delete offer |
| GET | /api/v1/admin/tractors | Yes | Admin | List all tractors |
| GET | /api/v1/admin/tractor/:id/document/:type | Yes | Admin | Secure tractor document access |
| PATCH | /api/v1/admin/tractor/:id/verify-document | Yes | Admin | Verify specific tractor document |
| GET | /api/v1/admin/operator/:id/document/:type | Yes | Admin | Secure operator document access |
| PATCH | /api/v1/admin/operator/:id/verify-documents | Yes | Admin | Verify operator documents |
| POST | /api/v1/admin/tractors | Yes | Admin | Create tractor from admin panel |
| PATCH | /api/v1/admin/tractors/:id | Yes | Admin | Update tractor from admin panel |
| DELETE | /api/v1/admin/tractors/:id | Yes | Admin | Delete tractor from admin panel |

### Super Admin

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| POST | /api/v1/super-admin/bootstrap | Yes | Super Admin | Bootstrap super admin setup |
| POST | /api/v1/super-admin/create-admin | Yes | Super Admin | Create admin account |
| GET | /api/v1/super-admin/admins | Yes | Super Admin | List admins |
| GET | /api/v1/super-admin/admin-activity | Yes | Super Admin | List admin activity logs |
| PATCH | /api/v1/super-admin/admins/:id/status | Yes | Super Admin | Activate/deactivate admin |
| PATCH | /api/v1/super-admin/deactivate-admin/:id | Yes | Super Admin | Deprecated admin status alias |

### Support / Misc

| Method | Path | Auth Required | Role | Description |
|---|---|---|---|---|
| GET | /api/v1/support | No | Public | Get support contact information |
| GET | /api/v1/offers | No | Public | List offers |
| GET | /api/v1/offers/active | No | Public | List active offers |
| POST | /api/v1/complaints | Yes | Any user | Create complaint |
| GET | /api/v1/complaints | Yes | Any user | List own complaints |
| GET | /api/v1/notifications | Yes | Any user | List notifications |
| PATCH | /api/v1/notifications/read-all | Yes | Any user | Mark all notifications read |
| PATCH | /api/v1/notifications/:id/read | Yes | Any user | Mark notification read |
| GET | /api/v1/services | No | Public | List active services |
| GET | /api/v1/services/all | No | Public | List all services |
| POST | /api/v1/services/admin | Yes | Admin | Create service |
| PATCH | /api/v1/services/admin/:id | Yes | Admin | Update service |
| PATCH | /api/v1/services/admin/:id/toggle | Yes | Admin | Toggle service active status |
| GET | /api/health | No | Public | Health check |
| GET | /api/v1/version | No (404 in production) | Public | Version/queue info for non-prod |
| GET | /metrics | No | Public/ops | Prometheus metrics endpoint |
| GET | /api-docs | No | Public | Swagger UI |
| GET | /api/v1/dev/test | Dev-only | Public (dev mode) | Development test endpoint |
| GET | /api/v1/dev/test-user | Dev-only | Public (dev mode) | Create/get test user in dev mode |

---

## 🚀 Overview

KH Agriconnect Backend is a scalable API platform that connects farmers with tractor operators for booking agricultural services.

It supports:
- 📍 Nearby tractor discovery
- 📅 Booking lifecycle management
- 💳 Secure payments (advance + remaining)
- 🔔 Real-time notifications
- 🛡️ Admin control and verification

## 🏗️ System Architecture


Farmer / Operator / Admin
        ↓
Node.js + Express API
        ↓
Routes → Controllers → Services → Models
        ↓
MongoDB

External Services:
- Razorpay (Payments)
- OTP Service
- Notification Service

## Production Highlights

- **Auth security hardening:** OTP verification uses atomic consume semantics and attempt limits; access/refresh token handling is separated (`tokenType`) and refresh tokens are rejected on access-protected routes.
- **Payment safety:** Razorpay payment and webhook signature verification are enforced in production; payment amount checks and payment-id reuse protections are in place.
- **Booking race protection:** booking creation uses lock + transaction + duplicate checks (including DB duplicate key mapping) to prevent parallel duplicate bookings.
- **Redis-backed stability/performance:** auth cache (short TTL), distributed locks, and queue workers reduce DB load and prevent concurrent state corruption in multi-instance deployments.



### Required files to run the app

| Item | Purpose |
|------|---------|
| `package.json` / `package-lock.json` | Dependencies and scripts |
| `server.js` | Process entry (HTTP + Socket.IO) |
| `src/` | Application code (routes, controllers, services, models) |
| `.env` | **You create this** (never commit secrets). Copy `.env.example` and fill values. |

**Optional at runtime:** For **FCM push**, set `ENABLE_FIREBASE_FCM=true` and install/configure Firebase credentials (`serviceAccountKey.json` or `FIREBASE_SERVICE_ACCOUNT_PATH`). If FCM is disabled, notifications still work via database + Socket.IO. The `logs/` folder is created automatically in production.

### Updates (2026-04-01)

- **Tractor details (backward compatible):** `GET /api/tractor/:id` and `GET /api/tractor/details/:id` use the same handler and return the same JSON. Existing clients can keep using either URL.
- **Admin list pagination:** `GET /api/admin/bookings`, `GET /api/admin/users`, and `GET /api/admin/complaints` accept optional `?page=1&limit=10` (default page `1`, limit `10`, max limit `100`). Existing response keys are unchanged; responses also include `data`, `total`, `page`, and `totalPages` inside the success payload.

---

## 14. Testing

Basic automated tests have been added using Jest.

### TEST SUMMARY

- **Total test suites:** 129
- **Total tests:** 643
- **Key areas covered:** authentication (OTP/JWT/refresh), booking lifecycle and state transitions, payments/webhooks/reconciliation
- **Test types:** integration, edge-case/regression, concurrency/race-condition coverage

### Coverage includes

- OTP generation validation
- Booking creation validation
- Payment verification (development and production scenarios)
- API route-stack and E2E flows (MongoMemoryServer), webhooks, reconciliation paths, and related unit tests

### How to run tests

```bash
npm test
```

### Coverage snapshot (current, approximate)

- Overall coverage is around **71% statements** and **57% branches**.
- Stronger areas include **review controller**, **cache service**, **webhook/payment queue flows**, and broad **auth/booking/payment integration paths**.
- Largest remaining low-coverage surfaces are very large controllers with many guarded branches (`booking.controller.js`, `admin.controller.js`).

### Updates (2026-04-07)

- **Node 20 runtime alignment:** `package.json` now declares **`engines.node >= 20`** and `.nvmrc` is set to **`20`**.
- **OTP storage hardened (backward compatible):** user OTP is stored as **bcrypt hash**; verification supports both hashed and legacy plain OTP values.
- **Payment integrity hardened (UPI/Razorpay):**
  - **Strict** `paymentId` reuse prevention across bookings.
  - **Server-side amount validation**: booking expected amount is compared against the **Razorpay payment amount** fetched by `paymentId`.
- **Secure document access enforcement (optional):**
  - `REQUIRE_SECURE_DOCUMENTS=true` blocks access when stored document URLs appear publicly accessible.
  - Logs **error** when Cloudinary/S3 URLs look public/unsigned.

---

### Updates (2026-04-10)

- **Super admin admin management (backward compatible):**
  - `PATCH /api/super-admin/deactivate-admin/:id` now **toggles** `isActive` (activate/deactivate) while keeping the route name unchanged.
  - `GET /api/super-admin/admins` lists all `role: "admin"` admins with safe fields only.
- **Admin OTP restriction:** OTP verification rejects disabled admins with message **"Admin account is disabled"**.
- **Admin activity logging (additive, non-blocking):**
  - A new `AdminActivityLog` collection records key admin actions (operator/tractor verification, service create/update/toggle, refund decisions, admin lifecycle).
  - Super admins can query logs via `GET /api/super-admin/admin-activity` with filters `adminId`, `action`, `page`, `limit`.

### Updates (2026-04-13)

- **Redis auth cache (production-ready):**
  - User auth middleware now checks Redis first, then DB fallback, and caches user state for **60s**.
  - Block/unblock admin action invalidates user auth cache immediately.
- **Distributed cron safety:**
  - Booking reminder cron now uses a Redis-based leader lock so only one instance runs scheduled actions in clustered deployments.
  - Optional lock TTL: `CRON_LOCK_TTL_MS` (default `55000`).
- **Socket.IO horizontal scaling support:**
  - Redis adapter integration added (feature flag: `ENABLE_SOCKET_IO_REDIS`).
  - Defaults: `true` in production when unset, `false` in non-production when unset.
- **Support endpoint config externalized:**
  - `GET /api/support` now reads `SUPPORT_PHONE` and `SUPPORT_MESSAGE` from env (with safe defaults, response format unchanged).
- **Dependency hardening:**
  - Production dependency audit is clean (`npm audit --omit=dev` => 0 vulnerabilities).

### Updates (2026-04-16)

- **Admin dashboard analytics endpoints (admin-auth protected):**
  - `GET /api/admin/dashboard/bookings` → totals by lifecycle status (`total`, `pending`, `accepted`, `completed`, `cancelled`).
  - `GET /api/admin/dashboard/revenue` → `totalRevenue`, `todayRevenue`, `monthRevenue` from booking/platform fee aggregates.
  - `GET /api/admin/dashboard/users` → `totalFarmers`, `totalOperators`.
- **Operational safety middleware now active in app bootstrap:**
  - Global request timeout (`10s`) via `requestTimeout`.
  - Production-only Mongo readiness gate (`503 Database unavailable`) via `mongoConnectionSafety`.
  - Centralized hard-fail production env validation via `src/config/env.js`.

## Deployment Readiness

- **Environment validation:** startup validates required runtime config (`MONGO_URI`, `JWT_SECRET`, CORS and production integration checks), and warns on risky production config.
- **Redis dependency model:** production startup expects Redis/queue readiness for lock and worker consistency; development can degrade gracefully.
- **External services:** Razorpay/MSG91/SMTP/storage are integration-checked at startup and fail safely at runtime with explicit errors when unavailable.

## System Reliability Notes

- **Webhook handling:** Razorpay webhook payloads are signature-verified, deduplicated, and queued; duplicate events are acknowledged safely.
- **Retry and recovery:** payment reconciliation and finalizer paths are idempotent/lock-protected; notification delivery uses retry + cleanup; failed external calls are logged with non-blocking fallbacks where applicable.
- **Error containment:** centralized error middleware plus structured logs keeps failures visible without crashing normal request flow.

## GitHub push gate (tests/load test)

- Before pushing to GitHub, require at least:
  - `npm test` (must pass)
  - your load-test command/script (must pass threshold for error rate/latency)
- Recommended policy: block merge/deploy if either functional tests or load-test gates fail.

## Logging system

The app uses **[Winston](https://github.com/winstonjs/winston)** via `src/utils/logger.js`. Import the singleton as:

`const { logger } = require("./src/utils/logger");`

### Production (`NODE_ENV=production`)

- Logs are written under the project’s **`logs/`** directory (created automatically).
- **`logs/error.log`** — only **`error`** level (failures, stacks where applicable).
- **`logs/combined.log`** — **`info`** and above (**`info`**, **`warn`**, **`error`**).
- Format is **JSON lines** (timestamp, message, metadata, stack on errors).
- **No console transport** in production — use files or ship logs to your aggregator.

The global **`errorHandler`** logs all handled errors with **`logger.error()`** before sending a safe response to the client.

### Development

- Logs go to the **console** only (colorized, human-readable).
- **`logs/`** file transports are **not** used, so local development stays simple.

### Operations tips

- Add **`logs/`** to backups or log shipping as needed (the repo **`.gitignore`** excludes `logs/`).

---

## MongoDB indexes

Indexes are declared on Mongoose schemas under `src/models/` (not in a separate migration folder). On connect, Mongoose ensures they exist; **existing production clusters** may need a deploy/restart or a one-off `syncIndexes()` if you add indexes outside a release.

### Collections and index intent

| Collection | Index pattern (summary) | Why |
|------------|-------------------------|-----|
| **bookings** | `farmer` / `operator` + `status` + `createdAt` (desc); `farmer` / `operator` + `createdAt`; partial **unique** `farmer` while “active”; partial **unique** `tractor` + `date` + `time` for active slot; `status` + `createdAt`; `status` + `lockExpiresAt`; `status` + `updatedAt`; `createdAt` | Farmer/operator history, admin lists, duplicate-active protection, machine slot conflicts, live/admin sorts, payment-lock expiry cron, stuck `payment_pending` monitoring |
| **payments** | `bookingId` + `type` (+ `createdAt`); **unique** `bookingId` + `type`; **unique** `paymentId` (non-empty); `status`; `status` + `createdAt` (asc); `userId` + `createdAt`; `refundStatus` | Per-booking payment rows, Razorpay idempotency, reconciliation queue, “my payments”, refunds |
| **users** | **unique** `phone`; `2dsphere` `location`; `role` + `verificationStatus`; `role` + `phone`; `createdAt` | Auth, nearby operators, admin listings |
| **tractors** | `operatorId` + verification + availability; `2dsphere` `location`; `isAvailable`; `verificationStatus` + `isDeleted` + `createdAt` | Operator fleet, geo search, admin pending queue |
| **complaints** | `status` + `createdAt`; `createdAt`; single-field refs (`userId`, etc.) | Admin triage and chronological lists |
| **commissions** | partial **unique** `active` (only `active: true`); `active` + `updatedAt` | Single active commission row + “latest active” reads |
| **webhookevents** | **unique** `provider` + `eventId`; TTL on `expiresAt` | Razorpay dedupe + retention |
| **idempotencykeys** | **unique** `userId` + `key` + `method` + `path`; TTL on `expiresAt` | Safe retries on mutating APIs |

### Legacy Atlas cleanup

If an old **operator + date + time** unique index still exists from an earlier schema, run `node scripts/dropOldBookingIndex.js` once against the database (see script header). The app now enforces slot uniqueness on **tractor** + date + time.

---

## MongoDB Backup & Restore Strategy (Atlas)

Use MongoDB Atlas managed backups for production data protection.

### Backup configuration

1. In Atlas, open your **Production Cluster**.
2. Go to **Backup** (or **Cloud Backups**).
3. Enable **Automatic Backups**.
4. Configure snapshot cadence:
   - **Daily snapshots**: enabled
   - Recommended backup policy:
     - Hourly snapshots retained for **24 hours**
     - Daily snapshots retained for **35 days**
     - Weekly snapshots retained for **8 weeks**
     - Monthly snapshots retained for **12 months**

### Backup frequency

- Minimum production baseline: **daily snapshots**
- Recommended: keep hourly + daily + weekly + monthly tiers as above for better incident recovery options.

### Retention policy

- Keep retention aligned with compliance/business requirements.
- Suggested default for this backend:
  - Daily: **35 days**
  - Weekly: **8 weeks**
  - Monthly: **12 months**

### Restore from snapshot (Atlas)

1. Go to Atlas **Backup** and locate the required snapshot timestamp.
2. Click **Restore**.
3. Choose restore mode:
   - **Restore to new cluster** (safest; recommended first)
   - **Restore to existing cluster** (only during controlled maintenance windows)
4. Wait for restore completion.
5. Update app `MONGO_URI` if restoring to a new cluster.
6. Run smoke checks:
   - `GET /api/health`
   - Critical read endpoints
   - Authentication + booking flow sanity
7. If validated, switch traffic/cutover and monitor logs.

### Restore safety notes

- Prefer restoring into a **new cluster** first to avoid accidental overwrite.
- Test restore drills periodically (at least quarterly).
- Ensure application credentials/network access exist for restored clusters before cutover.

---

## Socket.IO security

Real-time notifications are emitted to room names like **`user:<mongoUserId>`** (see `src/services/notification.service.js`).

### JWT in the handshake

- Every Socket.IO connection must present a **valid user JWT** before the connection is accepted.
- The server reads the token from:
  - **`handshake.auth.token`**, or
  - **`Authorization: Bearer <token>`** on the handshake.
- Tokens are verified with **`JWT_SECRET`** (same as REST). **Admin** tokens (`scope: "admin"`) are **rejected** on the socket layer so only **end-user** sessions are allowed.

### Rooms and subscriptions

- After authentication, the server sets **`socket.data.userId`** from **`decoded.id`**.
- The socket **automatically joins** **`user:<userId>`** so push notifications reach the correct client without extra steps.
- The **`subscribe_user`** event is still supported for backward compatibility, but the server **only** re-joins the room if the requested id **matches** the authenticated user — **cross-user subscription is not allowed**.

### Client example

```javascript
import { io } from "socket.io-client";

const socket = io("https://your-api.com", {
  auth: { token: userJwtFromLogin },
});
```

If authentication fails, the connection will be rejected (handle **`connect_error`** in the client).

---

## Duplicate booking protection

When a **farmer** creates a booking (`POST /api/bookings/create`), the backend avoids duplicate “active” bookings for the same farmer (per your defined active statuses).

### MongoDB transactions (preferred)

- A **MongoDB session** runs a **`withTransaction`** callback that:
  1. **`findOne`** — checks whether the farmer already has an active booking (same filter as before).
  2. If found → returns a **409** duplicate error.
  3. If not → **`Booking.create([payload], { session })`** so the check and insert are **atomic** within the transaction.

**Requirement:** MongoDB **replica set** (e.g. Atlas or a self-managed replica set). Transactions are **not** supported on a single-node **standalone** server in the classic sense.

### Fallback when transactions are unavailable

If the transaction path fails with a **non-application** error (e.g. standalone Mongo, transient driver error), the code:

1. Runs **`Booking.exists`** again for the same farmer + active statuses.
2. If still active → **409** duplicate.
3. Otherwise **`Booking.create(payload)`** without a session.

This **narrows** the race compared to a single pre-check, but on **standalone** Mongo a tiny race window can still exist under extreme concurrency. **Use a replica set in production** for the strongest guarantee.

An early **`Booking.exists`** before heavy work is still performed for **fast failure** when a duplicate already exists.

---

## Service layer (integrations)

External integrations are isolated under **`src/services/`**. They are designed to **degrade gracefully** when credentials are missing or APIs fail.

| Service | File | Behavior |
|--------|------|----------|
| **OTP** | `otp.service.js` | With **MSG91** env vars → send OTP via API. Otherwise → **console** fallback (dev-style; ensure production uses real SMS). |
| **Payment** | `payment.service.js` | With **Razorpay** keys → real orders + signature verification. Otherwise → **mock** responses so flows can be tested. |
| **Storage** | `storage.service.js` | With **AWS S3**-style env → upload to bucket. Otherwise → **dummy URL** (`resolveDocumentInput` for multipart-style docs). |
| **Maps** | `maps.service.js` | With **`GOOGLE_MAPS_API_KEY`** → Distance Matrix for distance/duration. Otherwise (or on API error) → **Haversine** + **30 km/h** ETA fallback. |

Controllers call these services where applicable (e.g. auth OTP after save, booking payments, document resolution, booking track/ETA).

---

## Validation layer

Request validation uses **[Joi](https://joi.dev/)** and a small reusable middleware:

- **`src/middleware/validate.middleware.js`** — `validate(schema, source)` defaults to **`req.body`**.
- **`src/validations/auth.validation.js`** — OTP send / verify (phone, OTP format).
- **`src/validations/booking.validation.js`** — booking **create** and **estimate** payloads.
- **`src/validations/user.validation.js`** — farmer profile update.

### Where it is applied

Validation runs **on the route**, **before** the controller:

- **`POST /api/auth/send-otp`**, **`POST /api/auth/verify-otp`**
- **`POST /api/bookings/create`**, **`POST /api/bookings/estimate`**
- **`POST /api/user/profile/farmer`**

Other endpoints still rely on **controller-level** checks. Invalid requests on validated routes receive **400** with a Joi-derived message; the global error handler does not crash the process on bad input.

### Auth rate limit

**`POST /api/auth/send-otp`** additionally uses **express-rate-limit** (stricter than the global API limiter) to reduce abuse.

---

## Revenue Calculation Logic

This backend’s **revenue analytics** (e.g. `GET /api/admin/dashboard/revenue`) are computed from **successful payment events**, not booking document timestamps.

- **Recognition event**: revenue is counted when the **final charge is completed**.
  - Current system is a **2-step payment flow**:
    - **advance** payment is **not** counted as revenue
    - **remaining** payment **is** counted as revenue
- **Assumption**: each booking produces **at most one** “revenue-recognition” payment event.
- **Future note**: if a **full-payment** flow is introduced, revenue logic must be updated to include that payment type **without double counting** (the current aggregation already supports a future `type: "full"` by deduping per booking).

---