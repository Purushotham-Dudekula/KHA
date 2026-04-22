/**
 * OpenAPI 3.0 specification for major HTTP surface (Auth, Bookings, Payments, Admin).
 * Served read-only at GET /api-docs
 */
module.exports = {
  openapi: "3.0.3",
  info: {
    title: "KH Agriconnect API",
    version: "1.0.0",
    description:
      "REST API for farmers, operators, payments, and admin. Authenticated routes expect `Authorization: Bearer <JWT>`.",
  },
  servers: [{ url: "/", description: "Current host" }],
  tags: [
    { name: "Auth", description: "OTP login for farmers and operators" },
    { name: "Bookings", description: "Booking lifecycle and payments on bookings" },
    { name: "Payments", description: "Payment history" },
    { name: "Admin", description: "Admin authentication and operations" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
      adminBearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Admin JWT from POST /api/admin/login",
      },
    },
    schemas: {
      SuccessEnvelope: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          message: { type: "string" },
          data: { type: "object", additionalProperties: true },
        },
      },
      ErrorEnvelope: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          message: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/api/auth/send-otp": {
      post: {
        tags: ["Auth"],
        summary: "Send OTP to phone",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["phone"],
                properties: { phone: { type: "string", example: "+919876543210" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "OTP dispatched", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessEnvelope" } } } },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/api/auth/verify-otp": {
      post: {
        tags: ["Auth"],
        summary: "Verify OTP and receive JWT",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["phone", "otp"],
                properties: {
                  phone: { type: "string" },
                  otp: { type: "string" },
                  role: { type: "string", enum: ["farmer", "operator"] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Session created", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessEnvelope" } } } },
        },
      },
    },
    "/api/bookings/create": {
      post: {
        tags: ["Bookings"],
        summary: "Create booking (farmer)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["serviceType", "date", "time"],
                properties: {
                  tractorId: { type: "string", description: "Preferred; operator derived from tractor" },
                  operatorId: { type: "string" },
                  serviceType: { type: "string" },
                  date: { type: "string", format: "date" },
                  time: { type: "string", example: "09:30" },
                  landArea: { type: "number" },
                  address: { type: "string" },
                  hours: { type: "number" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Booking created" },
          "409": { description: "Farmer already has an active booking" },
        },
      },
    },
    "/api/bookings/{id}/pay-advance": {
      post: {
        tags: ["Bookings"],
        summary: "Pay advance (UPI / Razorpay)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  paymentMethod: { type: "string", enum: ["upi"] },
                  orderId: { type: "string" },
                  paymentId: { type: "string" },
                  signature: { type: "string", description: "Razorpay signature (required in production)" },
                  razorpay_signature: { type: "string" },
                  transactionId: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Advance recorded" },
          "400": { description: "Verification failed or invalid state" },
        },
      },
    },
    "/api/bookings/{id}/pay-remaining": {
      post: {
        tags: ["Bookings"],
        summary: "Pay remaining balance",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  paymentMethod: { type: "string", enum: ["upi"] },
                  orderId: { type: "string" },
                  paymentId: { type: "string" },
                  signature: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Balance recorded" },
          "400": { description: "Invalid booking or verification failed" },
        },
      },
    },
    "/api/payments/my": {
      get: {
        tags: ["Payments"],
        summary: "List current user's payments",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Payment list" },
        },
      },
    },
    "/api/admin/login": {
      post: {
        tags: ["Admin"],
        summary: "Admin login (email + password)",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Admin JWT issued" },
          "401": { description: "Invalid credentials" },
        },
      },
    },
    "/api/admin/me": {
      get: {
        tags: ["Admin"],
        summary: "Current admin profile",
        security: [{ adminBearerAuth: [] }],
        responses: {
          "200": { description: "Admin user" },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/api/admin/dashboard": {
      get: {
        tags: ["Admin"],
        summary: "Dashboard metrics",
        security: [{ adminBearerAuth: [] }],
        responses: { "200": { description: "Dashboard payload" } },
      },
    },
  },
};
