// Forkcast by Ainex — OpenStreetMap edition. No API key needed.
window.FORKCAST_CONFIG = {
  DEFAULT_RADIUS_M: 1500,      // search radius in meters
  REFRESH_DISTANCE_M: 400,     // live mode: rescan after moving this far
  MIN_REFRESH_MS: 45000,       // live mode: never rescan more often than this
  MAX_RESULTS: 40,             // how many places to show in the list

  // Used if the user blocks location access
  FALLBACK_CENTER: { lat: 14.5995, lng: 120.9842 },

  // Map tiles (the map pictures)
  TILE_URL: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  TILE_ATTRIBUTION: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',

  // Free servers that return restaurant data. The app tries them in order.
  OVERPASS_ENDPOINTS: [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter"
  ],
  REQUEST_TIMEOUT_MS: 40000    // slow free servers need more time
};