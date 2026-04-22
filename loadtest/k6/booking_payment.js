import http from "k6/http";
import { check, group, sleep } from "k6";
import { randomIntBetween, uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

/**
 * Real-world booking flow load test:
 * farmer create booking -> operator accept -> farmer pay advance
 *
 * Notes:
 * - Requires valid JWTs for farmer/operator accounts.
 * - Operator must own the tractor(s) used here and be verification-eligible.
 * - For production, use real Razorpay order/payment/signature values.
 */

const BASE_URL = __ENV.BASE_URL || "http://localhost:5000";
const API_BASE = __ENV.API_BASE || "/api";
const FARMER_JWT = __ENV.FARMER_JWT || "";
const OPERATOR_JWT = __ENV.OPERATOR_JWT || "";
const TRACTOR_IDS = String(__ENV.TRACTOR_IDS || __ENV.TRACTOR_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SERVICE_TYPE = __ENV.SERVICE_TYPE || "ploughing";
const LOADTEST_DEV_PAYMENT_BYPASS = String(__ENV.LOADTEST_DEV_PAYMENT_BYPASS || "")
  .trim()
  .toLowerCase() === "true";
const RAZORPAY_ORDER_ID = String(__ENV.RAZORPAY_ORDER_ID || "").trim();
const RAZORPAY_PAYMENT_ID = String(__ENV.RAZORPAY_PAYMENT_ID || "").trim();
const RAZORPAY_SIGNATURE = String(__ENV.RAZORPAY_SIGNATURE || "").trim();
const IS_CI = String(__ENV.CI || "")
  .trim()
  .toLowerCase() === "true";

const farmerHeaders = {
  "Content-Type": "application/json",
  ...(FARMER_JWT ? { Authorization: `Bearer ${FARMER_JWT}` } : {}),
};

const operatorHeaders = {
  "Content-Type": "application/json",
  ...(OPERATOR_JWT ? { Authorization: `Bearer ${OPERATOR_JWT}` } : {}),
};

export const options = {
  vus: IS_CI ? 1 : 100,
  duration: IS_CI ? "5s" : "1m",
  thresholds: {
    http_req_duration: ["p95<500"],
    http_req_failed: ["rate<0.01"],
  },
};

function apiUrl(path) {
  return `${BASE_URL}${API_BASE}${path}`;
}

export default function () {
  if (!FARMER_JWT || !OPERATOR_JWT || TRACTOR_IDS.length === 0) {
    // Fail fast with an obvious signal in the output.
    const res = http.get(`${BASE_URL}/__missing_env`);
    check(res, {
      "provide FARMER_JWT OPERATOR_JWT TRACTOR_IDS env vars": () => false,
    });
    sleep(1);
    return;
  }

  let bookingId = "";
  const journeyId = uuidv4();
  const tractorId = TRACTOR_IDS[__VU % TRACTOR_IDS.length];
  const dayOffset = randomIntBetween(2, 8);
  const slotHour = (__VU + __ITER) % 10; // spreads slots to reduce collision
  const slotMinute = (__VU * 7 + __ITER * 3) % 60;
  const hh = String(8 + slotHour).padStart(2, "0");
  const mm = String(slotMinute).padStart(2, "0");
  const slotTime = `${hh}:${mm}`;
  const bookingDate = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000).toISOString();

  group("booking.create", () => {
    const payload = {
      tractorId: String(tractorId),
      serviceType: SERVICE_TYPE,
      date: bookingDate,
      time: slotTime,
      landArea: 2,
      address: `Load test addr ${journeyId}`,
    };

    const res = http.post(apiUrl("/bookings/create"), JSON.stringify(payload), {
      headers: { ...farmerHeaders, "Idempotency-Key": `book-${journeyId}` },
    });

    check(res, {
      "booking create status is 201": (r) => r.status === 201,
    });

    if (res.status === 201) {
      const body = res.json();
      bookingId = body?.data?.booking?._id || "";
    }
  });

  if (!bookingId) {
    sleep(0.05);
    return;
  }

  group("booking.accept", () => {
    const res = http.post(
      apiUrl(`/bookings/${bookingId}/respond`),
      JSON.stringify({ action: "accept" }),
      { headers: operatorHeaders }
    );
    check(res, {
      "status is 200": (r) => r.status === 200,
    });
  });

  group("payment.advance", () => {
    const payload = LOADTEST_DEV_PAYMENT_BYPASS
      ? {
          paymentMethod: "upi",
          transactionId: `txn_${__VU}_${__ITER}_${Date.now()}`,
        }
      : {
          paymentMethod: "upi",
          orderId: RAZORPAY_ORDER_ID,
          paymentId: RAZORPAY_PAYMENT_ID,
          signature: RAZORPAY_SIGNATURE,
        };

    if (!LOADTEST_DEV_PAYMENT_BYPASS && (!RAZORPAY_ORDER_ID || !RAZORPAY_PAYMENT_ID || !RAZORPAY_SIGNATURE)) {
      check(null, {
        "provide valid Razorpay order/payment/signature or enable LOADTEST_DEV_PAYMENT_BYPASS": () => false,
      });
      sleep(0.05);
      return;
    }

    const res = http.post(
      apiUrl(`/bookings/${bookingId}/pay-advance`),
      JSON.stringify(payload),
      {
        headers: {
          ...farmerHeaders,
          "Idempotency-Key": `adv-${journeyId}`,
        },
      }
    );
    check(res, {
      "status is 200": (r) => r.status === 200,
    });
  });

  sleep(0.05);
}

