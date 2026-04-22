# Runbook

## Environment variables

- `REQUIRE_SECURE_DOCUMENTS` must be set to `true` in production.
- `STAGING_URL` GitHub secret is required for the `load-test` CI job.

## CI/CD Secrets Setup

### Adding STAGING_URL to GitHub Secrets
1. Go to the repository **Settings** -> **Secrets and variables** -> **Actions**.
2. Click **New repository secret**.
3. Name: `STAGING_URL`
4. Value: `your staging server URL` (e.g., `https://your-staging-url.com`)
5. Click **Add secret**.
   - This enables automatic load testing on every PR to main.
   - **Note**: STAGING_URL secret must be added to GitHub repo secrets before load tests will run. Until then, the job skips gracefully.

## CI/CD Manual Workflows

### Running Load Tests Manually
1. Go to the **Actions** tab in your GitHub repository.
2. Select the **Backend Pipeline** (or **load-test**) workflow from the left sidebar.
3. Click the **Run workflow** dropdown on the right.
4. Enter the **Staging URL** to run the load test against.
5. Click **Run workflow**.

## MongoDB

- Monitor pool exhaustion via MongoDB Atlas Metrics -> Connections chart. Current maxPoolSize: 50.

## BullMQ

Worker concurrency is configured via env vars. Payment worker is intentionally lower (3) to prevent financial op overload. Tune notification/webhook workers up under sustained load.

## Production Deployment

- PM2 cluster start: `pm2 start ecosystem.config.js --env production`
- PM2 reload (zero downtime): `pm2 reload kh-agriconnect`
- ECS: set task count > 1 in ECS service definition. Redis adapter already handles multi-instance WebSocket via `ENABLE_SOCKET_IO_REDIS=true`.
- Health check endpoint for ALB: `GET /health`
- Distributed cron lock is already in place via Redis, so only one instance runs cron per cluster.
