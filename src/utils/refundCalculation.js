function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Pure refund / penalty estimate from current booking state (call before status → cancelled).
 *
 * Policy:
 * - pending → full refund, no penalty
 * - accepted (and confirmed/en_route: pre-start commitment) → time-based partial refund
 * - in_progress / completed / payment_pending → no refund, full penalty
 * - other terminal or unknown statuses → 0 / 0
 *
 * @param {{ status: string; totalAmount?: number; startTime?: Date|string|null; date?: Date|string }} booking
 * @returns {{ refundAmount: number; penalty: number }}
 */
function calculateRefundDetails(booking) {
  const now = new Date();
  const startTime = new Date(booking.startTime);

  let refundAmount = 0;
  let penalty = 0;

  const totalAmount = Math.max(0, Number(booking.totalAmount) || 0);

  if (booking.status === "pending") {
    refundAmount = totalAmount;
    penalty = 0;
  } else if (
    booking.status === "accepted" ||
    booking.status === "confirmed" ||
    booking.status === "en_route"
  ) {
    const diffMs = Number.isNaN(startTime.getTime()) ? 0 : startTime - now;
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours > 2) {
      refundAmount = totalAmount * 0.8;
      penalty = totalAmount * 0.2;
    } else {
      refundAmount = totalAmount * 0.5;
      penalty = totalAmount * 0.5;
    }
  } else if (
    booking.status === "in_progress" ||
    booking.status === "completed" ||
    booking.status === "payment_pending"
  ) {
    refundAmount = 0;
    penalty = totalAmount;
  }

  return { refundAmount: round2(refundAmount), penalty: round2(penalty) };
}

/**
 * Single source of truth for refundAmount + penalty (cancellationCharge) used by:
 * cancel, refund preview, and admin refund audit.
 *
 * When the actor is the farmer and advance is already paid, policy is no refund and
 * full booking total is recorded as cancellation charge (operator-initiated cancels keep
 * calculator output so advance refund flows stay intact).
 *
 * @param {{ status: string; paymentStatus?: string; totalAmount?: number; startTime?: Date|string|null }} booking
 * @param {{ actorIsFarmer: boolean }} options
 * @returns {{ refundAmount: number; penalty: number }}
 */
function resolveRefundSnapshot(booking, { actorIsFarmer }) {
  let { refundAmount, penalty } = calculateRefundDetails(booking);
  const totalAmount = Math.max(0, Number(booking.totalAmount) || 0);

  if (booking.paymentStatus === "advance_paid" && actorIsFarmer === true) {
    refundAmount = round2(0);
    penalty = round2(totalAmount);
  }

  return { refundAmount, penalty };
}

module.exports = { calculateRefundDetails, resolveRefundSnapshot };
