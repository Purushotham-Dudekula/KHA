jest.mock("axios");

const axios = require("axios");
const { logger } = require("../../src/utils/logger");
const { getDistanceAndETA } = require("../../src/services/maps.service");

describe("maps.service", () => {
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
    jest.restoreAllMocks();
  });

  test("throws when coordinates are not finite", async () => {
    await expect(
      getDistanceAndETA({ lat: NaN, lng: 1 }, { lat: 2, lng: 3 })
    ).rejects.toThrow(/valid lat and lng/);
  });

  test("uses haversine fallback when API key missing", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const out = await getDistanceAndETA(
      { lat: 17.4, lng: 78.5 },
      { lat: 17.41, lng: 78.51 }
    );
    expect(Number.isFinite(out.distanceKm)).toBe(true);
    expect(Number.isFinite(out.durationMinutes)).toBe(true);
  });

  test("uses Google matrix when key present and response OK", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "k";
    axios.get.mockResolvedValue({
      data: {
        status: "OK",
        rows: [
          {
            elements: [
              {
                status: "OK",
                distance: { value: 5000 },
                duration: { value: 600 },
              },
            ],
          },
        ],
      },
    });
    const out = await getDistanceAndETA(
      { lat: 12, lng: 77 },
      { lat: 13, lng: 77 }
    );
    expect(out.distanceKm).toBe(5);
    expect(out.durationMinutes).toBe(10);
  });

  test("falls back when API returns non-OK status", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "k";
    axios.get.mockResolvedValue({
      data: { status: "REQUEST_DENIED", error_message: "x" },
    });
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    const out = await getDistanceAndETA(
      { lat: 10, lng: 20 },
      { lat: 10.1, lng: 20.1 }
    );
    expect(Number.isFinite(out.distanceKm)).toBe(true);
  });

  test("falls back when axios throws", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "k";
    axios.get.mockRejectedValue(new Error("timeout"));
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    const out = await getDistanceAndETA(
      { lat: 1, lng: 2 },
      { lat: 1.01, lng: 2.01 }
    );
    expect(Number.isFinite(out.distanceKm)).toBe(true);
  });
});
