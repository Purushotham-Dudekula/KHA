/**
 * Scheduled start instant (UTC) from booking.date + booking.time "HH:mm".
 */
function getBookingScheduledAtMs(booking) {
  const d = new Date(booking.date);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const t = (booking.time || "").trim();
  if (!t) {
    return Date.UTC(y, mo, day, 0, 0, 0, 0);
  }
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) {
    return Date.UTC(y, mo, day, 0, 0, 0, 0);
  }
  let h = parseInt(m[1], 10);
  let min = parseInt(m[2], 10);
  if (h > 23) h = 23;
  if (min > 59) min = 59;
  return Date.UTC(y, mo, day, h, min, 0, 0);
}

module.exports = { getBookingScheduledAtMs };
