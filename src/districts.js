// Petropavlovsk-Kamchatsky district zones for GTA SA district entry banner

export const PK_DISTRICTS = [
  { name: 'Центр / Пл. Ленина', lat: 53.0241, lon: 158.6455, radiusMeters: 1050 },
  { name: 'КП', lat: 53.0369, lon: 158.6565, radiusMeters: 780 },
  { name: '4-й километр', lat: 53.0445, lon: 158.6505, radiusMeters: 520 },
  { name: '5-й километр', lat: 53.0505, lon: 158.6410, radiusMeters: 480 },
  { name: '6-й километр', lat: 53.0556, lon: 158.6345, radiusMeters: 430 },
  { name: 'Силуэт', lat: 53.0585, lon: 158.6295, radiusMeters: 850 },
  { name: 'Горизонт', lat: 53.0545, lon: 158.6615, radiusMeters: 1200 },
  { name: 'Сероглазка', lat: 53.0461, lon: 158.5940, radiusMeters: 1250 },
  { name: 'Моховая', lat: 53.0625, lon: 158.5773, radiusMeters: 1250 },
  { name: 'СРВ', lat: 52.9765, lon: 158.6880, radiusMeters: 1500 },
  { name: 'Завойко', lat: 52.9540, lon: 158.6731, radiusMeters: 1450 }
];

const DEG2RAD = Math.PI / 180;

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Returns the closest Petropavlovsk-Kamchatsky district containing (lat, lon), or null.
 */
export function findDistrictAt(lat, lon) {
  let best = null;
  let bestRatio = Infinity;

  for (const district of PK_DISTRICTS) {
    const dist = distanceMeters(lat, lon, district.lat, district.lon);
    if (dist <= district.radiusMeters) {
      const ratio = dist / district.radiusMeters;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = district.name;
      }
    }
  }

  return best;
}
