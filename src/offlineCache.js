import { MAPTILER_KEY } from './mapStyle.js';

// Petropavlovsk-Kamchatsky bounds: Zavoyko & SRV -> Mokhovaya & 10th km
const PK_BOUNDS = {
  minLat: 52.96,
  maxLat: 53.12,
  minLon: 158.55,
  maxLon: 158.75
};

const TILES_CACHE_NAME = 'maptiler-tiles-cache';
const FONTS_CACHE_NAME = 'maptiler-fonts-cache';

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom
  );
}

function buildOfflineDownloadQueue() {
  const queue = [
    {
      url: `https://api.maptiler.com/tiles/v3/tiles.json?key=${MAPTILER_KEY}`,
      cacheName: TILES_CACHE_NAME
    },
    {
      url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`,
      cacheName: TILES_CACHE_NAME
    }
  ];

  // Essential Latin + Cyrillic glyph ranges for map labels
  const fontStacks = [
    'Roboto Regular,Noto Sans Regular',
    'Roboto Medium,Noto Sans Regular'
  ];
  const glyphRanges = ['0-255', '1024-1279'];
  for (const stack of fontStacks) {
    for (const range of glyphRanges) {
      queue.push({
        url: `https://api.maptiler.com/fonts/${encodeURIComponent(stack)}/${range}.pbf?key=${MAPTILER_KEY}`,
        cacheName: FONTS_CACHE_NAME
      });
    }
  }

  // Vector tiles zoom 11..15
  for (let z = 11; z <= 15; z++) {
    const xMin = lonToTileX(PK_BOUNDS.minLon, z);
    const xMax = lonToTileX(PK_BOUNDS.maxLon, z);
    const yMin = latToTileY(PK_BOUNDS.maxLat, z);
    const yMax = latToTileY(PK_BOUNDS.minLat, z);

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        queue.push({
          url: `https://api.maptiler.com/tiles/v3/${z}/${x}/${y}?key=${MAPTILER_KEY}`,
          cacheName: TILES_CACHE_NAME
        });
        // Terrain-RGB-v2 maxzoom is 14
        if (z <= 14) {
          queue.push({
            url: `https://api.maptiler.com/tiles/terrain-rgb-v2/${z}/${x}/${y}?key=${MAPTILER_KEY}`,
            cacheName: TILES_CACHE_NAME
          });
        }
      }
    }
  }

  return queue;
}

/**
 * Pre-fetches and caches all Petropavlovsk-Kamchatsky vector & 3D terrain tiles
 * for zoom 11..15 into Workbox's CacheStorage buckets.
 */
export async function downloadPetropavlovskOfflineMap({ onProgress, signal } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Нет подключения к сети для загрузки карты');
  }

  const queue = buildOfflineDownloadQueue();
  const total = queue.length;
  let completed = 0;
  let cachedCount = 0;
  let cursor = 0;

  const tilesCache = 'caches' in window ? await caches.open(TILES_CACHE_NAME) : null;
  const fontsCache = 'caches' in window ? await caches.open(FONTS_CACHE_NAME) : null;

  const report = () => {
    const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 100;
    onProgress?.(pct, completed, total);
  };

  report();

  const CONCURRENCY = 8;

  async function worker() {
    while (cursor < total) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const item = queue[cursor++];
      const targetCache = item.cacheName === FONTS_CACHE_NAME ? fontsCache : tilesCache;

      try {
        const existing = targetCache ? await targetCache.match(item.url) : null;
        if (existing) {
          cachedCount++;
        } else {
          const res = await fetch(item.url, { mode: 'cors', signal });
          if (res.ok || res.type === 'opaque') {
            if (targetCache) {
              await targetCache.put(item.url, res.clone());
            }
            cachedCount++;
          }
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        // Skip single transient tile failures without halting the batch
      } finally {
        completed++;
        report();
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (cachedCount === 0) {
    throw new Error('Не удалось загрузить тайлы карты');
  }

  localStorage.setItem('pk_offline_map_cached', String(Date.now()));
  return { total, cachedCount };
}

export function isOfflineMapCached() {
  return Boolean(localStorage.getItem('pk_offline_map_cached'));
}
