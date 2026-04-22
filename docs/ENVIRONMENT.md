# Environment Configuration Guide

This document lists environment variables used by the backend and how to prepare values for production deployment.

## Core

| Name | Required | Description | Example |
|---|---|---|---|
| `NODE_ENV` | Yes | Runtime mode (`development`, `test`, `production`). | `production` |
| `PORT` | No | HTTP server port. Defaults to `5000`. | `5000` |
| `JWT_SECRET` | Yes | JWT signing key (production must be 32+ chars). | `replace-with-long-random-secret` |
| `JWT_EXPIRES_IN` | Yes | JWT expiration duration. | `7d` |
| `REFRESH_TOKEN_SECRET` | No | Refresh token secret (future/client auth extension). | `replace-with-refresh-secret` |
| `REFRESH_TOKEN_EXPIRES_IN` | No | Refresh token expiration duration. | `30d` |
| `CORS_ORIGIN` | Yes | Allowed frontend origins (comma-separated). | `https://app.example.com,https://admin.example.com` |
| `DEV_ROUTE_SECRET` | Dev only | Secret used by development-only endpoints. | `dev-secret` |

## Database

| Name | Required | Description | Example |
|---|---|---|---|
| `MONGO_URI` | Yes | MongoDB connection URI. Atlas URI required in production by validation. | `mongodb+srv://user:pass@cluster.mongodb.net/kha` |

Indexes are defined in application models (`src/models/*.model.js`) and are ensured at runtime by Mongoose. For a full map of collections and index purposes, see **MongoDB indexes** in `README.md`. After upgrading to a build that adds new indexes, deploy or restart the API so connections can create them; optional one-off maintenance: `Model.syncIndexes()` in a controlled script if your ops policy requires it.

## Payment

| Name | Required | Description | Example |
|---|---|---|---|
| `RAZORPAY_KEY_ID` | Yes (prod) | Razorpay API key id. | `rzp_live_xxxxx` |
| `RAZORPAY_KEY_SECRET` | Yes (prod) | Razorpay API secret. | `xxxxxxxxxx` |
| `RAZORPAY_WEBHOOK_SECRET` | Yes (prod) | Secret used to verify Razorpay webhook signatures. | `webhook_secret` |
| `ALLOW_DEV_PAYMENT` | No | Enables dev bypass only in development. Keep `false` in prod. | `false` |
| `ALLOW_RECONCILE_FALLBACK` | No | Optional fallback behavior for reconciliation queue. | `false` |
| `PAYMENT_RECONCILE_CRON` | No | Cron expression for reconciliation job. | `*/3 * * * *` |

## Email

| Name | Required | Description | Example |
|---|---|---|---|
| `SMTP_HOST` | Yes (prod) | SMTP host for admin email OTP/alerts. | `smtp.sendgrid.net` |
| `SMTP_PORT` | No | SMTP port (default `587`). | `587` |
| `SMTP_USER` | Yes (prod) | SMTP auth username. | `apikey` |
| `SMTP_PASS` | Yes (prod) | SMTP auth password/key. | `SG.xxxxx` |
| `SMTP_SECURE` | No | Force secure SMTP mode. | `false` |
| `ADMIN_EMAIL_FROM` | Yes (prod) | From address for admin emails. | `no-reply@example.com` |
| `MAIL_USER` | No | Alternate SMTP username fallback. | `apikey` |
| `MAIL_PASS` | No | Alternate SMTP password fallback. | `SG.xxxxx` |

## Redis

| Name | Required | Description | Example |
|---|---|---|---|
| `REDIS_URL` | Yes (prod) | Redis URI for rate limit, queues, locks, socket adapter. | `redis://default:pass@host:6379` |
| `REDIS_DISABLED` | No | Disable Redis usage (useful in tests). | `false` |
| `ENABLE_SOCKET_IO_REDIS` | No | Force enable/disable Socket.IO Redis adapter. | `true` |
| `CRON_LOCK_TTL_MS` | No | TTL for cron lock safety. | `55000` |

## Storage

| Name | Required | Description | Example |
|---|---|---|---|
| `STORAGE_PROVIDER` | Yes (prod) | `s3` or `cloudinary`. | `s3` |
| `AWS_ACCESS_KEY_ID` | Yes (prod, S3) | AWS access key id. | `AKIA...` |
| `AWS_SECRET_ACCESS_KEY` | Yes (prod, S3) | AWS secret access key. | `xxxxxxxx` |
| `AWS_ACCESS_KEY` | No | Alternate key id variable. | `AKIA...` |
| `AWS_SECRET` | No | Alternate secret variable. | `xxxxxxxx` |
| `AWS_REGION` | No | AWS region (defaults to `ap-south-1`). | `ap-south-1` |
| `AWS_S3_BUCKET` | Yes (prod, S3) | S3 bucket name. | `kha-prod-documents` |
| `S3_BUCKET` | No | Alternate bucket variable. | `kha-prod-documents` |
| `AWS_S3_PUBLIC_URL_BASE` | No | Public asset URL base. | `https://cdn.example.com` |
| `SIGNED_URL_EXPIRY` | No | Signed URL TTL seconds. | `600` |
| `REQUIRE_SECURE_DOCUMENTS` | No | Enforce secure document delivery behavior. | `true` |
| `CLOUDINARY_CLOUD_NAME` | Yes (prod, Cloudinary) | Cloudinary cloud identifier. | `mycloud` |
| `CLOUDINARY_API_KEY` | Yes (prod, Cloudinary) | Cloudinary API key. | `123456` |
| `CLOUDINARY_API_SECRET` | Yes (prod, Cloudinary) | Cloudinary API secret. | `abcdef` |

## Optional / Feature / Observability

| Name | Required | Description | Example |
|---|---|---|---|
| `SENTRY_DSN` | No | Sentry DSN for error tracking. | `https://xxx.ingest.sentry.io/xxx` |
| `SENTRY_TRACES_SAMPLE_RATE` | No | Sentry traces sample rate. | `0.1` |
| `LOG_LEVEL` | No | Logging verbosity level (if wired by runtime/log infra). | `info` |
| `ENABLE_METRICS` | No | Enable Prometheus metrics endpoint. | `true` |
| `ENABLE_SECURITY_HARDENING` | No | Enable security headers/sanitization middleware. | `true` |
| `ENABLE_FIREBASE_FCM` | No | Enable Firebase push initialization. | `false` |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | No | Path to Firebase service account JSON. | `/app/secrets/firebase.json` |
| `FCM_SERVER_KEY` | No | Legacy FCM key (kept for client checklist compatibility). | `AAAA...` |
| `ENABLE_NOTIFICATIONS` | No | Notification feature flag placeholder for deployment templates. | `true` |
| `ENABLE_EMAILS` | No | Email feature flag placeholder for deployment templates. | `true` |
| `RATE_LIMIT_WINDOW_MS` | No | Rate-limit window placeholder for deployment templates. | `900000` |
| `RATE_LIMIT_MAX_REQUESTS` | No | Rate-limit max requests placeholder for deployment templates. | `100` |
| `REQUEST_SIZE_LIMIT` | No | Request body size limit placeholder for deployment templates. | `10kb` |
| `MAX_FILE_SIZE` | No | File size limit placeholder for deployment templates. | `5242880` |
| `NOTIFICATION_RETRY_RETENTION_DAYS` | No | Notification retry retention days. | `14` |
| `GOOGLE_MAPS_API_KEY` | No | API key for map/address distance features. | `AIza...` |
| `SUPPORT_PHONE` | No | Support contact number shown by support endpoint. | `+911234567890` |
| `SUPPORT_MESSAGE` | No | Support message text shown by support endpoint. | `Contact support for help` |
| `MSG91_AUTH_KEY` | Yes (prod) | MSG91 auth key for OTP SMS. | `msg91-key` |
| `MSG91_TEMPLATE_ID` | Yes (prod) | MSG91 template id for OTP SMS. | `template-id` |

## Client Setup Guide

### 1) MongoDB Atlas

1. Create a MongoDB Atlas project and cluster.
2. Create a database user with least privileges.
3. Allowlist your backend server IPs (or private network peering).
4. Copy the Atlas connection string and set `MONGO_URI`.

### 2) Razorpay Account

1. Create Razorpay account and complete KYC.
2. Generate live API credentials (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`).
3. Store credentials in your secret manager and inject at runtime.

### 3) Razorpay Webhook

1. In Razorpay dashboard, create webhook URL: `https://<your-domain>/api/webhook/razorpay`.
2. Enable required payment events.
3. Set webhook secret in dashboard and in backend as `RAZORPAY_WEBHOOK_SECRET`.
4. Verify signatures in production logs before go-live.

### 4) SMTP Setup (Gmail / SendGrid)

- **Gmail:** use App Password (not account password), set host `smtp.gmail.com`, port `587`.
- **SendGrid:** use host `smtp.sendgrid.net`, user `apikey`, pass = SendGrid API key.
- Set `ADMIN_EMAIL_FROM` to a verified sender.

### 5) Redis (Optional outside production, recommended in production)

1. Provision managed Redis (Redis Cloud, AWS Elasticache, etc.).
2. Copy secure URL into `REDIS_URL`.
3. Keep `REDIS_DISABLED=false` in production.

## Security Warnings

- Never commit `.env` or real credentials to git.
- Use production/live keys only in production environments.
- Store secrets in a secure secret manager (Vault, AWS Secrets Manager, GCP Secret Manager, etc.).
- Rotate keys regularly and immediately on suspected exposure.
