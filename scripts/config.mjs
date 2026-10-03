// Shared bounding box + projection for the data pipeline and the app.
// East Pune: Koregaon Park, Kalyani Nagar, Viman Nagar, Yerawada, the airport,
// Bund Garden and Pune Junction, plus the Mula-Mutha river corridor.
export const BBOX = { south: 18.505, west: 73.858, north: 18.602, east: 73.948 };

// Local tangent-plane origin (roughly Aga Khan Palace / Kalyani Nagar).
export const ORIGIN = { lat: 18.553, lon: 73.903 };

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

// x = metres east, z = metres south (three.js: -z is north).
export function project(lat, lon) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
}

export function unproject(x, z) {
  return [ORIGIN.lat - z / M_PER_DEG_LAT, ORIGIN.lon + x / M_PER_DEG_LON];
}
