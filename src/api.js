// Geocoding (Photon + Nominatim scoped to Kamchatka Krai) and OSRM Routing

const KAMCHATKA_BBOX = {
  minLon: 155.5,
  minLat: 50.8,
  maxLon: 163.5,
  maxLat: 60.5
};

const PK_CENTER = { lat: 53.02, lon: 158.64 };

function formatPhotonLabel(props) {
  const parts = [];
  if (props.name) parts.push(props.name);
  if (props.street) {
    const streetStr = props.housenumber
      ? `${props.street}, ${props.housenumber}`
      : props.street;
    if (streetStr !== props.name) parts.push(streetStr);
  }
  const city = props.city || props.town || props.village || props.district;
  if (city && !parts.includes(city)) parts.push(city);
  if (props.state && !parts.includes(props.state)) parts.push(props.state);
  return parts.join(', ') || 'Точка на Камчатке';
}

function isInKamchatka(lat, lon) {
  return (
    lon >= KAMCHATKA_BBOX.minLon &&
    lon <= KAMCHATKA_BBOX.maxLon &&
    lat >= KAMCHATKA_BBOX.minLat &&
    lat <= KAMCHATKA_BBOX.maxLat
  );
}

/**
 * Search addresses and places in Petropavlovsk-Kamchatsky & Kamchatka Krai
 * via Photon API with automatic Nominatim fallback.
 */
export async function searchPlaces(query) {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { offline: true, items: [] };
  }

  const results = [];
  const seen = new Set();

  // 1. Photon API biased to Petropavlovsk-Kamchatsky and bounded to Kamchatka Krai
  try {
    const photonUrl = new URL('https://photon.komoot.io/api/');
    photonUrl.searchParams.set('q', trimmed);
    photonUrl.searchParams.set('lat', String(PK_CENTER.lat));
    photonUrl.searchParams.set('lon', String(PK_CENTER.lon));
    photonUrl.searchParams.set(
      'bbox',
      `${KAMCHATKA_BBOX.minLon},${KAMCHATKA_BBOX.minLat},${KAMCHATKA_BBOX.maxLon},${KAMCHATKA_BBOX.maxLat}`
    );
    photonUrl.searchParams.set('limit', '8');

    const res = await fetch(photonUrl.toString(), { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      for (const feat of data.features || []) {
        const [lon, lat] = feat.geometry?.coordinates || [];
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        if (!isInKamchatka(lat, lon)) continue;

        const props = feat.properties || {};
        const title = props.name || (props.street ? `${props.street}${props.housenumber ? ', ' + props.housenumber : ''}` : 'Точка');
        const subtitle = [
          props.street && props.name !== props.street
            ? `${props.street}${props.housenumber ? ', ' + props.housenumber : ''}`
            : null,
          props.city || props.town || props.village || 'Петропавловск-Камчатский',
          props.state || 'Камчатский край'
        ]
          .filter(Boolean)
          .join(', ');

        const key = `${lat.toFixed(4)}:${lon.toFixed(4)}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            title,
            subtitle,
            label: formatPhotonLabel(props),
            lat,
            lon,
            source: 'Photon'
          });
        }
      }
    }
  } catch (err) {
    console.warn('Photon search error:', err);
  }

  // 2. Nominatim fallback (or supplement when Photon returns few hits)
  if (results.length < 3) {
    try {
      const nomUrl = new URL('https://nominatim.openstreetmap.org/search');
      nomUrl.searchParams.set('format', 'jsonv2');
      nomUrl.searchParams.set('q', trimmed);
      nomUrl.searchParams.set(
        'viewbox',
        `${KAMCHATKA_BBOX.minLon},${KAMCHATKA_BBOX.maxLat},${KAMCHATKA_BBOX.maxLon},${KAMCHATKA_BBOX.minLat}`
      );
      nomUrl.searchParams.set('bounded', '1');
      nomUrl.searchParams.set('countrycodes', 'ru');
      nomUrl.searchParams.set('limit', '6');
      nomUrl.searchParams.set('accept-language', 'ru');

      const res = await fetch(nomUrl.toString(), { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const items = await res.json();
        for (const item of items) {
          const lat = parseFloat(item.lat);
          const lon = parseFloat(item.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const key = `${lat.toFixed(4)}:${lon.toFixed(4)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const parts = (item.display_name || '').split(',').map((s) => s.trim());
          results.push({
            title: item.name || parts[0] || trimmed,
            subtitle: parts.slice(1, 4).join(', ') || 'Камчатский край',
            label: parts.slice(0, 3).join(', ') || trimmed,
            lat,
            lon,
            source: 'Nominatim'
          });
        }
      }
    } catch (err) {
      console.warn('Nominatim search error:', err);
    }
  }

  return { offline: false, items: results.slice(0, 8) };
}

/**
 * Reverse geocode a clicked map coordinate via Photon -> Nominatim fallback.
 */
export async function reverseGeocode(lat, lon) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  }
  try {
    const res = await fetch(
      `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=1`,
      { signal: AbortSignal.timeout(3500) }
    );
    if (res.ok) {
      const data = await res.json();
      const props = data.features?.[0]?.properties;
      if (props) {
        const street = props.street
          ? `${props.street}${props.housenumber ? ', ' + props.housenumber : ''}`
          : '';
        const name = props.name || street || props.city || props.district;
        if (name) return name;
      }
    }
  } catch {
    // Ignore and fall back to coordinates
  }
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/**
 * Fetch driving route along real roads using public OSRM API.
 */
export async function fetchDrivingRoute(pointA, pointB) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('OFFLINE');
  }

  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${pointA.lon},${pointA.lat};${pointB.lon},${pointB.lat}` +
    `?overview=full&geometries=geojson&steps=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!res.ok) {
    throw new Error(`OSRM HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error('NO_ROUTE');
  }

  const route = data.routes[0];
  return {
    geometry: route.geometry,
    distanceMeters: route.distance,
    durationSeconds: route.duration
  };
}
