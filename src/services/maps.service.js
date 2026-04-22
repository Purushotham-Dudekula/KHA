const axios = require("axios");
const { logger } = require("../utils/logger");

const GOOGLE_DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const FALLBACK_SPEED_KMH = 30;
let didLogMissingMapsKeyFallback = false;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function fallbackDistanceAndDuration(origin, destination) {
  const d = haversineKm(origin.lat, origin.lng, destination.lat, destination.lng);
  const distanceKm = round2(d);
  const durationMinutes = round2((distanceKm / FALLBACK_SPEED_KMH) * 60);
  return { distanceKm, durationMinutes };
}

/**
 * @param {{ lat: number, lng: number }} origin
 * @param {{ lat: number, lng: number }} destination
 * @returns {Promise<{ distanceKm: number, durationMinutes: number }>}
 */
async function getDistanceAndETA(origin, destination) {
  const oLat = Number(origin?.lat);
  const oLng = Number(origin?.lng);
  const dLat = Number(destination?.lat);
  const dLng = Number(destination?.lng);

  if (![oLat, oLng, dLat, dLng].every((n) => Number.isFinite(n))) {
    throw new Error("origin and destination must include valid lat and lng.");
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !String(key).trim()) {
    if (!didLogMissingMapsKeyFallback) {
      didLogMissingMapsKeyFallback = true;
      logger.info("Using fallback distance calculation");
    }
    return fallbackDistanceAndDuration(
      { lat: oLat, lng: oLng },
      { lat: dLat, lng: dLng }
    );
  }

  try {
    const { data } = await axios.get(GOOGLE_DISTANCE_MATRIX_URL, {
      params: {
        origins: `${oLat},${oLng}`,
        destinations: `${dLat},${dLng}`,
        key: String(key).trim(),
      },
      timeout: 15000,
      validateStatus: (s) => s === 200,
    });

    if (data.status !== "OK") {
      logger.warn("Google Distance Matrix API status", { status: data.status, error_message: data.error_message });
      return fallbackDistanceAndDuration(
        { lat: oLat, lng: oLng },
        { lat: dLat, lng: dLng }
      );
    }

    const el = data.rows?.[0]?.elements?.[0];
    if (!el || el.status !== "OK") {
      return fallbackDistanceAndDuration(
        { lat: oLat, lng: oLng },
        { lat: dLat, lng: dLng }
      );
    }

    const meters = el.distance?.value;
    const seconds = el.duration?.value;
    if (!Number.isFinite(meters) || !Number.isFinite(seconds)) {
      return fallbackDistanceAndDuration(
        { lat: oLat, lng: oLng },
        { lat: dLat, lng: dLng }
      );
    }

    return {
      distanceKm: round2(meters / 1000),
      durationMinutes: round2(seconds / 60),
    };
  } catch (err) {
    logger.warn("Google Distance Matrix request failed", { message: err?.message });
    return fallbackDistanceAndDuration(
      { lat: oLat, lng: oLng },
      { lat: dLat, lng: dLng }
    );
  }
}

module.exports = { getDistanceAndETA };
