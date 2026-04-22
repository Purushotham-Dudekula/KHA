# KH Agriconnect Backend Technical Documentation

## 1. Project Overview

### System purpose
- KH Agriconnect is a backend platform that connects farmers with tractor operators and manages bookings, payments, approvals, and notifications.
- It acts as the central service for all business workflows: user authentication, tractor registration, booking lifecycle, payment processing, and administration.

### Problem statement
- Farmers need a reliable way to book agricultural equipment and services without manual search or coordination.
- Operators need a structured channel to receive work, update availability, and manage earnings.
- Admins need visibility and control over operator approvals, tractor verification, pricing, refunds, and platform safety.

### High-level architecture
- The system is built as a layered web service.
- Incoming requests enter through route handlers, move through validation and middleware, then execute business logic in controller and service layers.
- Data is persisted in MongoDB with dedicated collections for users, bookings, tractors, payments, notifications, and admin logs.
- External integrations include OTP delivery, Razorpay payments, and push notifications.

## 2. Tech Stack

- Node.js runtime
- Express web framework
- MongoDB database with Mongoose data modeling
- OTP-based authentication for both field users and admins
- Razorpay UPI payment integration for advance and remaining payments
- Socket and push notification support for real-time updates

## 3. System Architecture

### Layered structure
- Routes: define the API endpoints and attach middleware.
- Controllers: contain request handling logic and orchestration of services.
- Services: encapsulate reusable business operations such as payment verification, notifications, logging, and storage.
- Models: define MongoDB schema and enforce persistent data rules.

### Module separation
- Authentication module handles OTP sending, verification, and JWT issuance.
- Booking module manages booking lifecycle, price calculation, and status transitions.
- Tractor module manages equipment registration, documents, availability, and verification.
- Operator module handles operator profile updates, bank details, location, and earnings.
- Admin module manages approvals, pricing, audit logs, notifications, and refund decisions.
- Payment module integrates Razorpay and records payment transactions separately.
- Notification module persists notifications and retries delivery if push fails.
- Logging module records admin activity and audit actions for accountability.

## 4. User Roles & Access Control

### Farmer
- Can search for tractors and services.
- Can create bookings and make payments.
- Can track booking progress and read notifications.

### Operator
- Registers as a service provider and adds tractors.
- Uploads documents and updates availability.
- Accepts or rejects booking requests.
- Updates job progress and completes work.

### Admin
- Approves or rejects operator registrations and tractor documents.
- Manages pricing, offers, commissions, and seasonal pricing.
- Monitors bookings, payments, customers, and complaints.
- Reviews refunds and broadcast announcements.

### Super Admin
- Has full platform control and can manage admin accounts.
- Responsible for the highest-level governance and emergency access.

### Role-based middleware
- `protect`: validates user JWT and only allows farmer/operator access.
- `protectAdmin`: validates admin JWT and scope.
- `requireAdmin`: ensures the admin has the permission to use admin routes.
- `requireSuperAdmin`: enforces super admin authorization for super-admin only endpoints.

## 5. Authentication Flow

### OTP send/verify
- Users request an OTP using their phone number.
- Admins use email-based OTP for login and password reset.
- The system validates OTP input and verifies expiry/attempt limits.

### JWT generation
- Successful OTP verification issues a JWT token.
- Tokens include a scope to distinguish normal users from admin users.
- User tokens are rejected on admin routes and vice versa.

### Role handling
- Users are assigned roles such as farmer or operator during registration/profile setup.
- Admins are assigned either admin or super_admin roles.
- Role metadata is stored in the user or admin records and used by middleware.

## 6. Core Modules

### A) Booking System

#### Lifecycle
- `pending`: booking requested and waiting for operator response.
- `accepted`: operator agreed; advance payment becomes due.
- `rejected`: operator declined the request.
- `confirmed`: booking is firm and scheduled.
- `en_route`: operator is on the way to the farm.
- `in_progress`: work has started in the field.
- `completed`: work is finished, remaining payment may be due.
- `closed`: final terminal state after settlement.
- `cancelled`: booking stopped by farmer, operator, or system.

#### Status transitions
- Bookings start at `pending` when created.
- An operator response moves the booking into `accepted`, `confirmed`, or `rejected`.
- Payment actions drive the transition from advance due to balance due and then to final settlement.
- Job actions move the booking through `en_route`, `in_progress`, and `completed`.
- The system can auto-cancel if advance payment is not completed in time.

### B) Tractor System

#### machineryTypes
- Tractors declare supported service types as a list.
- The booking system validates service support against tractor capabilities.

#### optional subtypes
- Tractors can also define optional subtype classifications for more granular service matching.
- Bookings validate subtype selections when provided.

#### verification
- Tractor registration includes document upload and admin review.
- Verification status is stored as `pending`, `approved`, or `rejected`.
- Only approved and available tractors are eligible for bookings.

### C) Operator System

#### Registration + approval
- Operators register with a mobile number and optional profile details.
- They upload documents and tractor details.
- Admins approve the operator and their tractor before the operator can accept jobs.

### D) Admin System

#### Admin + Super Admin capabilities
- Admins manage operator and tractor approvals.
- They handle pricing, commission, offers, seasonal pricing, and refunds.
- They access analytics, live bookings, complaints, and audit logs.
- Super Admin manages admin users and supervises overall platform operations.

### E) Payment System

#### Razorpay integration
- Razorpay credentials are required in production.
- Payments are verified by comparing the payment signature against the order ID and payment ID.
- A development mode bypass exists when expressly enabled outside production.

#### Advance + remaining payment
- The booking calculates an advance amount as a percentage of the final total.
- Remaining payment is tracked separately and due after work completion.
- Payments are stored as types `advance` and `remaining`.

#### Verification logic
- The service checks Razorpay signatures to prevent tampering.
- It can also fetch payment amounts from Razorpay to verify the actual paid sum.
- Non-production environments may bypass verification for development convenience.

#### Dev vs production handling
- Production requires valid Razorpay keys and strict signature checks.
- Development can optionally allow payment flows without live Razorpay verification when configured.

### F) Notification System

#### Notification creation
- Notifications are persisted in MongoDB for every significant event.
- Events include booking updates, payment updates, refund status, and admin broadcasts.
- The system also emits real-time messages over Socket.IO when available.

#### Retry mechanism
- Failed push deliveries are queued into a retry collection.
- A background worker retries notifications up to a fixed limit.
- Older retry records are periodically cleaned up.
- FCM push is feature-flagged (`ENABLE_FIREBASE_FCM`) and optional; DB + Socket.IO notifications continue even when FCM is disabled.

### G) Logging System

#### AdminActivityLogs vs AdminAuditLogs
- `AdminActivityLogs` capture lightweight admin actions and are designed to never block business flow.
- `AdminAuditLogs` capture formal audit events for compliance and review.
- Both logs sanitize sensitive fields and keep a record of who performed what action.

## 7. Database Design

### Collections overview
- `User`: farmers and operators, with roles, profile, verification, location, bank details, and OTP state.
- `Admin`: admin and super admin users, OTP/email login, role, active state, and password/reset metadata.
- `Tractor`: equipment listings, operator relationship, verification status, availability, documents, and service capabilities.
- `Booking`: service bookings linking farmer, operator, tractor, status, payment details, and timestamps.
- `Payment`: individual payment transactions for advance and remaining amounts.
- `Notification`: stored notifications for users.
- `NotificationRetry`: retry records for failed notification deliveries.
- `Pricing`, `SeasonalPricing`, `Commission`, `Offer`: pricing and promotion metadata.
- `AdminActivityLog`, `AdminAuditLog`: audit and activity logging collections.

### Relationships
- Bookings reference farmers, operators, and tractors.
- Payments reference bookings and users.
- Tractors reference operators.
- Notifications reference users and optionally bookings.
- Admin logs reference admin users and target object IDs.

## 8. API Design

### Key endpoints
- `POST /api/auth/send-otp`: request user OTP.
- `POST /api/auth/verify-otp`: verify user OTP and receive JWT.
- `POST /api/tractor`: add a new tractor.
- `GET /api/tractor`: list operator tractors.
- `PATCH /api/tractor/:id/documents`: upload tractor documents.
- `POST /api/bookings/create`: create a new booking.
- `POST /api/bookings/:id/pay-advance`: pay advance amount.
- `POST /api/bookings/:id/pay-remaining`: pay remaining amount.
- `PATCH /api/bookings/:id/start`: operator starts the job.
- `PATCH /api/bookings/:id/complete`: complete the job.
- `GET /api/notifications`: list notifications.
- `GET /api/admin/tractors/pending`: list tractors pending verification.
- `PATCH /api/admin/verify-operator/:id`: approve an operator.
- `PATCH /api/admin/verify-tractor/:id`: approve a tractor.
- `POST /api/admin/notifications/broadcast`: broadcast a message.
- `POST /api/admin/refunds/:bookingId`: manage refund decisions.

### Request/response structure
- Requests are validated using schema checks before reaching controllers.
- Responses are normalized and typically include success status, payload data, and error messages.
- Sensitive fields such as OTP values, tokens, and internal identifiers are excluded from user-facing responses.

## 9. Security

### Middleware protection
- Authentication middleware checks Bearer tokens on protected routes.
- Admin middleware enforces admin scope and active account state.
- Rate limiting is applied to OTP, admin login, and payment endpoints.
- Auth middleware uses Redis-backed cache with 60-second TTL to reduce DB load in production.

### Validation
- Request payloads are validated using defined validation schemas.
- Input rules cover required fields, allowed formats, numeric ranges, and service-specific requirements.
- The booking system rejects invalid service types, mismatched operator/tractor pairing, and unsupported booking conditions.

### Payment integrity
- Razorpay signatures are verified to ensure payment authenticity.
- The system rejects payments with missing or invalid Razorpay fields.
- Development mode offers an explicit bypass only when configured and not in production.

## 10. Edge Case Handling

### Payment failures
- Payment flows have explicit error handling for invalid signature, missing fields, or verification mismatches.
- The system preserves payment state and does not advance booking status until payment is confirmed.

### Invalid bookings
- The booking creation flow rejects duplicate active bookings for a farmer.
- The system prevents farmers from booking themselves as operators.
- Only approved and available tractors can be used for booking.
- Subtype validation rejects unsupported tractor service variants.

### Duplicate requests
- Booking creation checks for active farmer bookings before allowing a new booking.
- Rate limiting reduces repeated OTP or payment attempts.
- Notification retry records prevent lost messages while avoiding repeated spamming.

## 11. Performance & Scalability

### Indexing
- User location uses a 2dsphere index for geospatial queries.
- Booking indexes support fast status, operator, and date lookups.
- Payment and log indexes support efficient history retrieval.

### Optimization
- The system avoids blocking business flows with best-effort logging and notification delivery.
- Shared service logic is centralized so improvements apply across endpoints.
- Validation occurs early to reduce expensive database operations for bad requests.
- Booking reminder cron uses a Redis leader lock to avoid duplicate execution in multi-instance deployments.
- Socket.IO supports Redis adapter mode (`ENABLE_SOCKET_IO_REDIS`) for cross-instance event delivery.

### Future scaling
- The layered architecture supports splitting services into microservices later.
- External integrations such as payment and notifications can be moved to dedicated workers.
- Database sharding or replica sets can support higher volume as usage grows.

## 12. Design Decisions

### OTP login
- OTP-based auth reduces onboarding friction for farmers and operators.
- Admins use email OTP for a more secure and auditable access path.

### Soft delete
- The backend preserves deleted tractors and bookings through status flags rather than hard deletion.
- This enables auditability, reporting, and safe recovery.

### Pricing priority logic
- The booking price selects the most specific rate available:
  - type-specific pricing for selected tractor/service combinations,
  - otherwise service-level pricing,
  - optionally adjusted by seasonal pricing.
- Offers are applied after the total is calculated, and platform commission is computed on the base amount.

## 13. Limitations & Improvements

- Refunds are currently handled via admin review rather than fully automated settlement.
- Wallet functionality is not yet implemented.
- Analytics are basic and can be enhanced with richer dashboards.
- Operator payout automation is not yet integrated with Razorpay or bank transfer flows.
- The system currently does not include a dedicated retry queue for booking retries beyond notifications.
- Future improvements include a wallet, better reporting, and stronger operational alerts.

## 14. Concurrency Handling (Production Paths)

### Booking creation locking and transaction boundaries
- Booking creation uses distributed locking plus a transactional create path to reduce parallel double-booking risk.
- The flow combines:
  - lock acquisition for farmer and slot,
  - duplicate-active check,
  - transactional insert,
  - duplicate-key mapping to stable API errors.
- This keeps behavior deterministic under near-simultaneous booking requests.

### Duplicate prevention strategy
- Application-level duplicate checks are applied before expensive work.
- Database-level partial unique indexes enforce hard constraints for active farmer bookings and active machine-slot conflicts.
- Duplicate key errors are normalized into user-facing conflict responses, preserving API stability.

### Transaction usage expectations
- Transactional safety depends on MongoDB replica-set capability.
- Operationally, production deployments should use Atlas/replica set mode so transaction paths are fully effective.

## 15. Security Hardening Details

### OTP atomic verification and replay resistance
- OTP verification includes:
  - expiry validation,
  - attempt counter with lockout,
  - atomic consume update to prevent OTP reuse in concurrent requests.
- OTP hash storage prevents plaintext OTP persistence in user/admin records.

### Token type separation
- JWTs are issued with explicit token intent (`access` vs `refresh`).
- Access middleware rejects refresh tokens even if cryptographically valid.
- Refresh endpoint validates token type, which prevents token confusion abuse.

### Sensitive field protection
- Responses intentionally omit sensitive fields (OTP hashes, token hashes, internal auth material).
- User/admin sanitization utilities are used before returning profile payloads.

## 16. Payment Reliability & Integrity

### Webhook verification and deduplication
- Webhook requests are validated with HMAC signature checks against raw body payload.
- Event deduplication prevents repeated processing from retries or replayed webhook deliveries.

### Finalizer behavior
- Payment finalization is idempotent and guarded by distributed locks.
- Finalizer updates payment + booking state transitions in a controlled sequence and avoids downgrades.

### Failure safety
- Signature mismatch, amount mismatch, or missing payment references fail fast with explicit error handling.
- Reconciliation workers provide eventual recovery when real-time webhook delivery is delayed.

## 17. Caching Strategy (Redis)

### Auth cache usage
- Auth middleware uses Redis-backed short TTL user cache to reduce repetitive DB reads under high request rates.
- Cache invalidation is triggered on critical account state changes (for example block/unblock workflows).

### Why this improves performance
- Removes repeated same-user lookups on protected endpoints.
- Reduces DB pressure and response-time variance in burst traffic.
- Supports multi-instance consistency when combined with shared Redis locks/queues.

## 18. Failure Handling Matrix

### If Redis fails
- In non-production/dev modes, selected features degrade gracefully (fallback logic where available).
- In production startup, Redis readiness is treated as a hard dependency for queue/lock consistency.

### If payment processing fails
- Payment verification failures do not silently advance booking state.
- Failed/partial payment states are retained and recoverable via reconciliation/finalizer idempotency.

### If external services fail
- OTP, notification, and storage/payment integrations are guarded by try/catch boundaries.
- Failures are logged with structured context; critical paths return stable error responses without process crashes.

## 19. Observability and Operations

### Logs
- Structured logging is applied across auth, booking, payment, queue, and admin flows.
- High-severity events (payment finalization mismatch, queue failures) are explicitly tagged for alerting.

### Error handling
- Centralized error middleware enforces consistent API error response shape.
- Controllers and services isolate operational failures to avoid cascading request-level crashes.

### Retry mechanisms
- Notification retry records + worker processing cover transient push failures.
- Payment reconciliation and webhook queue retries cover delayed/missed external events.

---

### Notes
- This document is intended for mentor and senior developer review.
- It captures the backend architecture, flows, business rules, and key technical decisions.
