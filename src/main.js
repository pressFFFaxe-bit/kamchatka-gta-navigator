import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { registerSW } from 'virtual:pwa-register';
import './style.css';
import { createGtaSaStyle } from './mapStyle.js';
import { fetchDrivingRoute, reverseGeocode, searchPlaces } from './api.js';
import { getPoiCategoryMeta, registerGtaPoiBlips } from './poiBlips.js';
import { findDistrictAt } from './districts.js';
import {
  downloadPetropavlovskOfflineMap,
  isOfflineMapCached
} from './offlineCache.js';

registerSW({ immediate: true });

const START_CENTER = [158.64, 53.02]; // lon, lat (Petropavlovsk-Kamchatsky)
const START_ZOOM = 13.6;
const START_PITCH = 52;
const START_BEARING = -25;
const OFF_ROUTE_THRESHOLD_METERS = 45;
const REROUTE_COOLDOWN_MS = 6000;

// DOM Elements
const modeGtaBtn = document.getElementById('mode-gta');
const modeSatBtn = document.getElementById('mode-satellite');
const searchInput = document.getElementById('search-input');
const btnSearch = document.getElementById('btn-search');
const searchResultsEl = document.getElementById('search-results');

const labelAEl = document.getElementById('label-a');
const labelBEl = document.getElementById('label-b');
const pickABtn = document.getElementById('pick-a');
const pickBBtn = document.getElementById('pick-b');
const btnClear = document.getElementById('btn-clear');

const btnRouteDetails = document.getElementById('btn-route-details');
const routeDetailsBodyEl = document.getElementById('route-details-body');
const statDistanceEl = document.getElementById('stat-distance');
const statDurationEl = document.getElementById('stat-duration');
const routeStatusEl = document.getElementById('route-status');

const btnDrive = document.getElementById('btn-drive');
const btnStop = document.getElementById('btn-stop');

const btnDownloadMap = document.getElementById('btn-download-map');
const offlineProgressWrapEl = document.getElementById('offline-progress-wrap');
const offlineProgressTextEl = document.getElementById('offline-progress-text');
const offlineProgressBarEl = document.getElementById('offline-progress-bar');

const speedReadoutEl = document.getElementById('speed-readout');
const mapHintTargetEl = document.getElementById('map-hint-target');

const gtaBannerEl = document.getElementById('gta-banner');
const gtaBannerTitleEl = document.getElementById('gta-banner-title');
const gtaBannerSubEl = document.getElementById('gta-banner-sub');

const hudPanelEl = document.getElementById('hud-panel');
const btnCollapse = document.getElementById('btn-collapse');
const districtToastEl = document.getElementById('district-toast');
const btnGps = document.getElementById('btn-gps');
const btnToggleStreets = document.getElementById('btn-toggle-streets');
const btnToggle3d = document.getElementById('btn-toggle-3d');

// Application State
const state = {
  mapMode: 'gta', // 'gta' | 'satellite'
  terrainEnabled: true,
  streetLabelsVisible: true,
  pickTarget: 'A', // 'A' | 'B'
  pointA: null, // { lat, lon, label }
  pointB: null, // { lat, lon, label }
  markerA: null,
  markerB: null,
  playerMarker: null,
  route: null, // { coordinates, distanceMeters, durationSeconds }
  tripActive: false,
  wakeLock: null,
  gps: {
    active: false,
    watchId: null,
    lastCoord: null,
    lastGeoCoord: null,
    lastRerouteAt: 0,
    rerouting: false,
    heading: 0
  },
  currentDistrict: null,
  districtTimer: null,
  bannerTimer: null
};

// Initialize MapLibre GL JS
const map = new maplibregl.Map({
  container: 'map',
  style: createGtaSaStyle(),
  center: START_CENTER,
  zoom: START_ZOOM,
  pitch: START_PITCH,
  bearing: START_BEARING,
  maxPitch: 75,
  antialias: true
});

map.on('error', (e) => {
  if (e?.error) {
    console.warn('MapLibre warning:', e.error.message || e.error);
  }
});

// Geometry & Distance Helpers
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDegrees([lon1, lat1], [lon2, lat2]) {
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * RAD2DEG) + 360) % 360;
}

function lerpAngle(current, target, t) {
  const diff = ((target - current + 540) % 360) - 180;
  return (current + diff * t + 360) % 360;
}

/**
 * Shortest distance in meters from point [lon, lat] to a polyline [[lon, lat], ...].
 */
function distanceToPolylineMeters(point, coordinates) {
  if (!coordinates || coordinates.length === 0) return Infinity;
  if (coordinates.length === 1) return haversineMeters(point, coordinates[0]);

  const refLatRad = point[1] * DEG2RAD;
  const metersPerDegLat = 111132.92;
  const metersPerDegLon = 111320 * Math.cos(refLatRad);

  const px = point[0] * metersPerDegLon;
  const py = point[1] * metersPerDegLat;

  let minSq = Infinity;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const ax = coordinates[i][0] * metersPerDegLon;
    const ay = coordinates[i][1] * metersPerDegLat;
    const bx = coordinates[i + 1][0] * metersPerDegLon;
    const by = coordinates[i + 1][1] * metersPerDegLat;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let t = 0;
    if (lenSq > 0) {
      t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    }

    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const distSq = (px - cx) ** 2 + (py - cy) ** 2;
    if (distSq < minSq) minSq = distSq;
  }

  return Math.sqrt(minSq);
}

// UI Helpers
function showGtaBanner(title, subtitle, variant = 'route') {
  clearTimeout(state.bannerTimer);
  gtaBannerTitleEl.textContent = title;
  gtaBannerSubEl.textContent = subtitle;
  gtaBannerEl.classList.toggle('is-finished', variant === 'finished');
  gtaBannerEl.classList.add('is-visible');
  state.bannerTimer = setTimeout(() => {
    gtaBannerEl.classList.remove('is-visible');
  }, 3600);
}

function formatDuration(seconds) {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} МИН`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} Ч ${m} МИН`;
}

function setStatus(text, isError = false) {
  routeStatusEl.textContent = text;
  routeStatusEl.classList.toggle('is-error', isError);
}

function setPanelCollapsed(collapsed) {
  hudPanelEl.classList.toggle('is-collapsed', collapsed);
  btnCollapse.textContent = collapsed ? '▸' : '▾';
}

function setPickTarget(target) {
  state.pickTarget = target;
  pickABtn.classList.toggle('is-picking', target === 'A');
  pickBBtn.classList.toggle('is-picking', target === 'B');
  mapHintTargetEl.textContent = target === 'A' ? 'Точку А' : 'Точку Б';
}

function updateSpeedometer(speedMps) {
  if (typeof speedMps === 'number' && Number.isFinite(speedMps) && speedMps >= 0) {
    speedReadoutEl.textContent = String(Math.round(speedMps * 3.6));
  } else {
    speedReadoutEl.textContent = '0';
  }
}

map.on('load', () => {
  registerGtaPoiBlips(map);
});
map.on('styleimagemissing', () => {
  registerGtaPoiBlips(map);
});

function showDistrictToast(name) {
  clearTimeout(state.districtTimer);
  districtToastEl.textContent = name;
  districtToastEl.classList.add('is-visible');
  state.districtTimer = setTimeout(() => {
    districtToastEl.classList.remove('is-visible');
  }, 3500);
}

function checkDistrictEntry(lat, lon) {
  const district = findDistrictAt(lat, lon);
  if (district && district !== state.currentDistrict) {
    state.currentDistrict = district;
    showDistrictToast(district);
  }
}

// Screen Wake Lock API
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (state.wakeLock && !state.wakeLock.released) return;
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
  } catch (err) {
    console.warn('Wake Lock request failed:', err?.message || err);
  }
}

async function releaseWakeLock() {
  if (!state.wakeLock) return;
  try {
    await state.wakeLock.release();
  } catch {
    // Ignore release error
  } finally {
    state.wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (state.tripActive && document.visibilityState === 'visible') {
    acquireWakeLock();
  }
});

// Custom Markers: GTA SA White 4-pointed Cross (Player / Point A) & Target Crosshair (Point B)
const WHITE_CROSS_SVG = `
  <svg viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">
    <polygon
      points="20,2 24.5,17.5 36,21 24.5,24.5 20,36 15.5,24.5 4,21 15.5,17.5"
      fill="#ffffff"
      stroke="#000000"
      stroke-width="2.8"
      stroke-linejoin="miter"
    />
  </svg>
`;

function createStartPinElement() {
  const el = document.createElement('div');
  el.className = 'gta-marker-pin--a';
  el.title = 'Точка старта (А)';
  el.innerHTML = WHITE_CROSS_SVG;
  return el;
}

function createTargetPinElement() {
  const el = document.createElement('div');
  el.className = 'gta-marker-pin--b';
  el.title = 'Цель (Точка Б)';
  el.innerHTML = `
    <svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true">
      <rect x="17.5" y="1" width="5" height="9" fill="#d92b2b" stroke="#000000" stroke-width="2" />
      <rect x="17.5" y="30" width="5" height="9" fill="#d92b2b" stroke="#000000" stroke-width="2" />
      <rect x="1" y="17.5" width="9" height="5" fill="#d92b2b" stroke="#000000" stroke-width="2" />
      <rect x="30" y="17.5" width="9" height="5" fill="#d92b2b" stroke="#000000" stroke-width="2" />
      <circle cx="20" cy="20" r="10.5" fill="#d92b2b" stroke="#000000" stroke-width="3" />
      <circle cx="20" cy="20" r="3.8" fill="#000000" />
    </svg>
  `;
  return el;
}

function createPlayerArrowElement() {
  const wrapper = document.createElement('div');
  wrapper.className = 'gta-player-arrow';
  wrapper.innerHTML = WHITE_CROSS_SVG;
  return wrapper;
}

function syncStartAndPlayerMarkers() {
  if (!state.markerA) return;
  const el = state.markerA.getElement();
  // Avoid overlapping two crosses when live GPS playerMarker is active
  el.style.display = state.gps.active && state.playerMarker ? 'none' : 'grid';
}

function ensurePlayerMarker(coord, bearing = 0) {
  if (!state.playerMarker) {
    state.playerMarker = new maplibregl.Marker({
      element: createPlayerArrowElement(),
      anchor: 'center',
      rotationAlignment: 'map',
      pitchAlignment: 'map'
    })
      .setLngLat(coord)
      .setRotation(bearing)
      .addTo(map);
  } else {
    state.playerMarker.setLngLat(coord).setRotation(bearing);
  }
  syncStartAndPlayerMarkers();
}

function attachWaypointMarker(slot, lat, lon) {
  const isA = slot === 'A';
  const existing = isA ? state.markerA : state.markerB;
  if (existing) {
    existing.setLngLat([lon, lat]);
    if (isA) syncStartAndPlayerMarkers();
    return existing;
  }

  const el = isA ? createStartPinElement() : createTargetPinElement();

  const marker = new maplibregl.Marker({
    element: el,
    anchor: 'center',
    draggable: true
  })
    .setLngLat([lon, lat])
    .addTo(map);

  marker.on('dragend', () => {
    const pos = marker.getLngLat();
    setWaypoint(slot, pos.lat, pos.lng, null, false);
  });

  if (isA) {
    state.markerA = marker;
    syncStartAndPlayerMarkers();
  } else {
    state.markerB = marker;
  }
  return marker;
}

// Set Waypoint A or B
async function setWaypoint(slot, lat, lon, label = null, flyToPoint = false) {
  const displayLabel = label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const pointObj = { lat, lon, label: displayLabel };

  if (slot === 'A') {
    state.pointA = pointObj;
    labelAEl.textContent = displayLabel;
    attachWaypointMarker('A', lat, lon);
    if (!state.pointB) {
      setPickTarget('B');
    }
  } else {
    state.pointB = pointObj;
    labelBEl.textContent = displayLabel;
    attachWaypointMarker('B', lat, lon);
  }

  if (flyToPoint) {
    map.easeTo({
      center: [lon, lat],
      zoom: Math.max(map.getZoom(), 14.4),
      duration: 650
    });
  }

  if (!label) {
    reverseGeocode(lat, lon).then((resolved) => {
      if (slot === 'A' && state.pointA && state.pointA.lat === lat && state.pointA.lon === lon) {
        state.pointA.label = resolved;
        labelAEl.textContent = resolved;
      }
      if (slot === 'B' && state.pointB && state.pointB.lat === lat && state.pointB.lon === lon) {
        state.pointB.label = resolved;
        labelBEl.textContent = resolved;
      }
    });
  }

  if (state.pointA && state.pointB) {
    await calculateAndDrawRoute();
  }
}

function setRouteLineStyle(isOfflineDirect) {
  if (map.getLayer('route-line')) {
    map.setLayoutProperty('route-line', 'visibility', isOfflineDirect ? 'none' : 'visible');
  }
  if (map.getLayer('route-line-dashed')) {
    map.setLayoutProperty('route-line-dashed', 'visibility', isOfflineDirect ? 'visible' : 'none');
  }
}

function fitRouteBounds(coordinates) {
  const bounds = new maplibregl.LngLatBounds();
  for (const c of coordinates) bounds.extend(c);
  const isMobile = window.innerWidth <= 768;
  map.fitBounds(bounds, {
    padding: isMobile
      ? { top: 180, bottom: 90, left: 32, right: 32 }
      : { top: 80, bottom: 90, left: 400, right: 80 },
    pitch: state.terrainEnabled ? 48 : 0,
    maxZoom: 15.5,
    duration: 900
  });
}

function applyOfflineDirectRoute({ silentBanner = false, fitMap = true } = {}) {
  const coordinates = [
    [state.pointA.lon, state.pointA.lat],
    [state.pointB.lon, state.pointB.lat]
  ];
  const straightMeters = Math.max(1, haversineMeters(coordinates[0], coordinates[1]));
  const estSeconds = straightMeters / 11.11; // ~40 km/h estimate

  state.route = {
    coordinates,
    distanceMeters: straightMeters,
    durationSeconds: estSeconds,
    isOfflineDirect: true
  };

  const routeSource = map.getSource('route');
  if (routeSource) {
    routeSource.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates }
    });
  }
  setRouteLineStyle(true);

  const kmStr = `${(straightMeters / 1000).toFixed(2)} КМ`;
  const durStr = formatDuration(estSeconds);

  statDistanceEl.textContent = `${kmStr} (ПРЯМО)`;
  statDurationEl.textContent = durStr;
  setStatus('Офлайн-режим: прямой курс до цели. При появлении сети маршрут перестроится по дорогам.');

  btnDrive.disabled = state.tripActive;
  btnStop.disabled = !state.tripActive;

  if (fitMap) fitRouteBounds(coordinates);
  if (!silentBanner) {
    showGtaBanner('ПРЯМОЙ КУРС (ОФЛАЙН)', `${kmStr} • ${durStr}`, 'route');
  }
}

async function calculateAndDrawRoute({ silentBanner = false, fitMap = true } = {}) {
  if (!state.pointA || !state.pointB) return;

  if (!silentBanner) {
    setStatus('Расчёт маршрута OSRM...');
    btnDrive.disabled = true;
    btnStop.disabled = true;
  }

  try {
    const result = await fetchDrivingRoute(state.pointA, state.pointB);
    const coordinates = result.geometry.coordinates;

    state.route = {
      coordinates,
      distanceMeters: result.distanceMeters,
      durationSeconds: result.durationSeconds,
      isOfflineDirect: false
    };

    const routeSource = map.getSource('route');
    if (routeSource) {
      routeSource.setData({
        type: 'Feature',
        geometry: result.geometry
      });
    }
    setRouteLineStyle(false);

    const kmStr = `${(result.distanceMeters / 1000).toFixed(2)} КМ`;
    const durStr = formatDuration(result.durationSeconds);

    statDistanceEl.textContent = kmStr;
    statDurationEl.textContent = durStr;
    setStatus(
      state.tripActive
        ? 'Поездка активна — ведение по маршруту'
        : 'Маршрут готов. Нажмите «ПОЕХАЛИ» для навигации.'
    );

    btnDrive.disabled = state.tripActive;
    btnStop.disabled = !state.tripActive;

    if (fitMap) fitRouteBounds(coordinates);

    if (!silentBanner) {
      showGtaBanner('МАРШРУТ ПРОЛОЖЕН', `${kmStr} • ${durStr}`, 'route');
    }
  } catch (err) {
    console.warn('OSRM unavailable, using offline direct course:', err?.message || err);
    applyOfflineDirectRoute({ silentBanner, fitMap });
  }
}

function clearRouteLayer() {
  state.route = null;
  const routeSource = map.getSource('route');
  if (routeSource) {
    routeSource.setData({ type: 'FeatureCollection', features: [] });
  }
  statDistanceEl.textContent = '— КМ';
  statDurationEl.textContent = '— МИН';
  btnDrive.disabled = true;
  btnStop.disabled = !state.tripActive;
}

// POI Blips Popup
let activePoiPopup = null;

function openPoiPopup(feature, clickLngLat) {
  const props = feature.properties || {};
  const coords =
    feature.geometry?.type === 'Point' && Array.isArray(feature.geometry.coordinates)
      ? feature.geometry.coordinates
      : [clickLngLat.lng, clickLngLat.lat];

  const meta = getPoiCategoryMeta(props.class);
  const placeName = props['name:ru'] || props.name || meta.fallbackName;

  if (activePoiPopup) {
    activePoiPopup.remove();
    activePoiPopup = null;
  }

  const cardEl = document.createElement('div');
  cardEl.className = 'poi-card';
  cardEl.innerHTML = `
    <span class="poi-card__cat">${escapeHtml(meta.category)}</span>
    <div class="poi-card__title">${escapeHtml(placeName)}</div>
    <button type="button" class="poi-card__btn">ПОЕХАТЬ СЮДА</button>
  `;

  const goBtn = cardEl.querySelector('.poi-card__btn');
  goBtn.addEventListener('click', async () => {
    if (activePoiPopup) {
      activePoiPopup.remove();
      activePoiPopup = null;
    }
    if (!state.pointA) {
      const startLon = state.gps.lastCoord ? state.gps.lastCoord[0] : START_CENTER[0];
      const startLat = state.gps.lastCoord ? state.gps.lastCoord[1] : START_CENTER[1];
      state.pointA = {
        lat: startLat,
        lon: startLon,
        label: state.gps.active ? 'Моя позиция GPS' : 'Центр (53.0200, 158.6400)'
      };
      labelAEl.textContent = state.pointA.label;
      attachWaypointMarker('A', startLat, startLon);
    }
    await setWaypoint('B', coords[1], coords[0], placeName, false);
  });

  activePoiPopup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: true,
    className: 'gta-poi-popup',
    offset: 16
  })
    .setLngLat(coords)
    .setDOMContent(cardEl)
    .addTo(map);
}

map.on('mouseenter', 'poi-blips', () => {
  map.getCanvas().style.cursor = 'pointer';
});

map.on('mouseleave', 'poi-blips', () => {
  map.getCanvas().style.cursor = '';
});

// Map Click: POI Blip Card OR Set Point A / B
map.on('click', (e) => {
  if (state.tripActive) return;
  if (e.originalEvent?.target?.closest('.maplibregl-marker, .maplibregl-popup')) return;

  const poiHits = map.getLayer('poi-blips')
    ? map.queryRenderedFeatures(e.point, { layers: ['poi-blips'] })
    : [];
  if (poiHits.length > 0) {
    openPoiPopup(poiHits[0], e.lngLat);
    return;
  }

  const { lat, lng } = e.lngLat;
  setWaypoint(state.pickTarget, lat, lng, null, false);
});

// Mode Switching: GTA SA vs Satellite
function setMapMode(mode) {
  state.mapMode = mode;
  modeGtaBtn.classList.toggle('is-active', mode === 'gta');
  modeSatBtn.classList.toggle('is-active', mode === 'satellite');

  const isSat = mode === 'satellite';
  if (map.getLayer('satellite-layer')) {
    map.setLayoutProperty('satellite-layer', 'visibility', isSat ? 'visible' : 'none');
  }

  const roadLayers = ['road-dirt-fill', 'road-minor-fill', 'road-secondary-fill', 'road-major-fill'];
  const casingLayers = ['road-dirt-casing', 'road-minor-casing', 'road-secondary-casing', 'road-major-casing'];
  for (const id of roadLayers) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', isSat ? 0.65 : 1);
  }
  for (const id of casingLayers) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', isSat ? 0.72 : 1);
  }
  if (map.getLayer('building-3d')) {
    map.setPaintProperty('building-3d', 'fill-extrusion-opacity', isSat ? 0.58 : 0.96);
  }
}

modeGtaBtn.addEventListener('click', () => setMapMode('gta'));
modeSatBtn.addEventListener('click', () => setMapMode('satellite'));

// Search Handling
let searchDebounce = null;

async function runSearch() {
  const query = searchInput.value.trim();
  if (!query) {
    searchResultsEl.classList.add('hidden');
    searchResultsEl.innerHTML = '';
    return;
  }

  searchResultsEl.classList.remove('hidden');
  searchResultsEl.innerHTML = '<li><span class="search-results__meta">Поиск по Камчатке...</span></li>';

  const { offline, items } = await searchPlaces(query);
  searchResultsEl.innerHTML = '';

  if (offline) {
    searchResultsEl.innerHTML =
      '<li><span class="search-results__meta">Офлайн: поиск недоступен — укажите Точку Б тапом по карте</span></li>';
    setStatus('Нет сети — выберите Точку Б кликом по карте');
    return;
  }

  if (items.length === 0) {
    searchResultsEl.innerHTML =
      '<li><span class="search-results__meta">Ничего не найдено в Петропавловске-Камчатском</span></li>';
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="search-results__name">${escapeHtml(item.title)}</span>
      <span class="search-results__meta">${escapeHtml(item.subtitle)}</span>
    `;
    li.addEventListener('click', () => {
      searchResultsEl.classList.add('hidden');
      searchInput.value = item.title;
      searchInput.blur();
      setWaypoint('B', item.lat, item.lon, item.label, true);
    });
    searchResultsEl.appendChild(li);
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  if (!searchInput.value.trim()) {
    searchResultsEl.classList.add('hidden');
    return;
  }
  searchDebounce = setTimeout(runSearch, 360);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchDebounce);
    runSearch();
  }
});

btnSearch.addEventListener('click', () => {
  clearTimeout(searchDebounce);
  runSearch();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-section')) {
    searchResultsEl.classList.add('hidden');
  }
});

// Pick / Clear / Route Details
pickABtn.addEventListener('click', () => setPickTarget('A'));
pickBBtn.addEventListener('click', () => setPickTarget('B'));

btnRouteDetails.addEventListener('click', () => {
  const isHidden = routeDetailsBodyEl.classList.toggle('hidden');
  btnRouteDetails.setAttribute('aria-expanded', String(!isHidden));
});

btnClear.addEventListener('click', () => {
  if (state.tripActive) stopTrip();
  else if (state.gps.active) stopGpsTracking(false);

  state.pointA = null;
  state.pointB = null;
  labelAEl.textContent = 'Кликните на карту';
  labelBEl.textContent = 'Кликните на карту или найдите';
  if (state.markerA) {
    state.markerA.remove();
    state.markerA = null;
  }
  if (state.markerB) {
    state.markerB.remove();
    state.markerB = null;
  }
  if (state.playerMarker) {
    state.playerMarker.remove();
    state.playerMarker = null;
  }
  clearRouteLayer();
  setPickTarget('A');
  setStatus('Укажите Точку А и Точку Б для построения маршрута');
});

// Active GPS Trip («ПОЕХАЛИ» / «СТОП») + Wake Lock + Auto-reroute
async function startTrip() {
  if (!state.route) return;
  state.tripActive = true;
  state.currentDistrict = null;
  btnDrive.disabled = true;
  btnStop.disabled = false;

  // Auto-collapse top HUD panel for maximum road visibility
  setPanelCollapsed(true);

  await acquireWakeLock();
  if (!state.gps.active) {
    startGpsTracking();
  }
  setStatus('Поездка активна — ведение по маршруту');
}

async function stopTrip() {
  state.tripActive = false;
  btnStop.disabled = true;
  btnDrive.disabled = !state.route;
  await releaseWakeLock();
  stopGpsTracking(false);

  map.easeTo({
    pitch: state.terrainEnabled ? START_PITCH : 0,
    duration: 500
  });
  setStatus(
    state.route
      ? 'Поездка остановлена. Нажмите «ПОЕХАЛИ» для старта.'
      : 'Укажите Точку А и Точку Б для построения маршрута.'
  );
}

btnDrive.addEventListener('click', startTrip);
btnStop.addEventListener('click', stopTrip);

// Collapse HUD
btnCollapse.addEventListener('click', () => {
  const willCollapse = !hudPanelEl.classList.contains('is-collapsed');
  setPanelCollapsed(willCollapse);
});

// Real GPS Tracking (navigator.geolocation.watchPosition)
function stopGpsTracking(updateStatusText = true) {
  if (state.gps.watchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(state.gps.watchId);
  }
  state.gps.watchId = null;
  state.gps.active = false;
  state.gps.rerouting = false;
  btnGps.classList.remove('is-active');
  updateSpeedometer(0);
  syncStartAndPlayerMarkers();

  if (updateStatusText) {
    setStatus(
      state.route
        ? 'GPS отключён. Маршрут готов.'
        : 'GPS отключён. Укажите Точку А и Точку Б.'
    );
  }
}

async function maybeRerouteFromGps(lat, lon) {
  if (!state.tripActive || !state.pointB || !state.route?.coordinates?.length) return;
  if (state.gps.rerouting) return;

  if (state.route.isOfflineDirect && navigator.onLine === false) {
    state.pointA = { lat, lon, label: state.pointA?.label || 'Моя позиция GPS' };
    applyOfflineDirectRoute({ silentBanner: true, fitMap: false });
    return;
  }

  const deviationMeters = distanceToPolylineMeters([lon, lat], state.route.coordinates);
  const shouldUpgradeOnline = state.route.isOfflineDirect && navigator.onLine !== false;
  if (!shouldUpgradeOnline && deviationMeters <= OFF_ROUTE_THRESHOLD_METERS) return;

  const now = Date.now();
  if (now - state.gps.lastRerouteAt < REROUTE_COOLDOWN_MS) return;

  state.gps.lastRerouteAt = now;
  state.gps.rerouting = true;
  setStatus(
    shouldUpgradeOnline
      ? 'Сеть появилась — перестроение по дорогам...'
      : `Сход с маршрута (${Math.round(deviationMeters)} м) — перестроение...`
  );

  try {
    state.pointA = { lat, lon, label: state.pointA?.label || 'Моя позиция GPS' };
    await calculateAndDrawRoute({ silentBanner: !shouldUpgradeOnline, fitMap: false });
  } finally {
    state.gps.rerouting = false;
  }
}

function startGpsTracking() {
  if (!('geolocation' in navigator)) {
    setStatus('Геолокация не поддерживается вашим браузером', true);
    return;
  }

  state.gps.active = true;
  state.gps.lastCoord = null;
  state.gps.lastGeoCoord = null;
  btnGps.classList.add('is-active');
  setStatus('Определение GPS-координат...');

  state.gps.watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      if (!state.gps.active) return;

      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const coord = [lon, lat];

      // Real speed in km/h (0 if coords.speed is null)
      updateSpeedometer(pos.coords.speed);

      // Determine heading from device course or movement vector
      let nextHeading = state.gps.heading;
      if (typeof pos.coords.heading === 'number' && Number.isFinite(pos.coords.heading)) {
        nextHeading = pos.coords.heading;
      } else if (state.gps.lastCoord) {
        const moved = haversineMeters(state.gps.lastCoord, coord);
        if (moved > 2) {
          nextHeading = bearingDegrees(state.gps.lastCoord, coord);
        }
      }
      state.gps.heading = lerpAngle(state.gps.heading, nextHeading, 0.55);
      state.gps.lastCoord = coord;

      ensurePlayerMarker(coord, state.gps.heading);
      checkDistrictEntry(lat, lon);

      // Update Point A to current GPS position
      const prevLabel = state.pointA?.label;
      state.pointA = {
        lat,
        lon,
        label: prevLabel && prevLabel !== 'Кликните на карту' ? prevLabel : 'Моя позиция GPS'
      };
      if (!state.gps.lastGeoCoord || haversineMeters(state.gps.lastGeoCoord, coord) > 60) {
        state.gps.lastGeoCoord = coord;
        labelAEl.textContent = state.pointA.label;
        reverseGeocode(lat, lon).then((resolved) => {
          if (state.gps.active && state.pointA) {
            state.pointA.label = `GPS: ${resolved}`;
            labelAEl.textContent = state.pointA.label;
          }
        });
      }
      attachWaypointMarker('A', lat, lon);

      map.easeTo({
        center: coord,
        bearing: state.gps.heading,
        pitch: state.terrainEnabled ? 62 : 0,
        zoom: Math.max(map.getZoom(), 16.0),
        duration: 500
      });

      if (state.tripActive) {
        setStatus('Поездка активна — ведение по маршруту');
        // Check arrival at destination B
        if (state.pointB && haversineMeters(coord, [state.pointB.lon, state.pointB.lat]) <= 35) {
          showGtaBanner('МАРШРУТ ЗАВЕРШЁН', 'ВЫ ПРИБЫЛИ В ПУНКТ Б', 'finished');
          await stopTrip();
          return;
        }
        // Check off-route deviation (> 45m) and auto-reroute (cooldown 6s)
        await maybeRerouteFromGps(lat, lon);
      } else {
        setStatus('GPS-трекинг активен');
        if (state.pointB && !state.route) {
          await calculateAndDrawRoute({ silentBanner: false, fitMap: false });
        }
      }
    },
    (err) => {
      console.warn('Geolocation error:', err);
      stopGpsTracking(false);
      if (state.tripActive) {
        state.tripActive = false;
        btnStop.disabled = true;
        btnDrive.disabled = !state.route;
        releaseWakeLock();
      }
      setStatus('Нет доступа к GPS или геолокация отключена в браузере', true);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 10000
    }
  );
}

btnGps.addEventListener('click', () => {
  if (state.gps.active) {
    if (state.tripActive) stopTrip();
    else stopGpsTracking(true);
  } else {
    startGpsTracking();
  }
});

// Street Labels Visibility Toggle («УЛИЦЫ»)
btnToggleStreets.addEventListener('click', () => {
  state.streetLabelsVisible = !state.streetLabelsVisible;
  btnToggleStreets.classList.toggle('is-active', state.streetLabelsVisible);

  const visibility = state.streetLabelsVisible ? 'visible' : 'none';
  for (const layerId of ['road-labels-major', 'road-labels-streets']) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  }
});

// 2D / 3D Toggle («3D РЕЛЬЕФ»)
function apply3dBuildingsHeight(is3d) {
  if (!map.getLayer('building-3d')) return;
  map.setPaintProperty(
    'building-3d',
    'fill-extrusion-height',
    is3d
      ? [
          'interpolate',
          ['linear'],
          ['zoom'],
          12,
          0,
          12.6,
          ['coalesce', ['get', 'render_height'], 12]
        ]
      : 0
  );
}

btnToggle3d.addEventListener('click', () => {
  state.terrainEnabled = !state.terrainEnabled;
  btnToggle3d.classList.toggle('is-active', state.terrainEnabled);

  if (state.terrainEnabled) {
    map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 });
  } else {
    map.setTerrain(null);
  }
  apply3dBuildingsHeight(state.terrainEnabled);

  const targetPitch = state.gps.active || state.tripActive
    ? (state.terrainEnabled ? 62 : 0)
    : (state.terrainEnabled ? START_PITCH : 0);
  map.easeTo({ pitch: targetPitch, duration: 480 });
});

// Auto-upgrade offline direct route to real OSRM road route when back online
window.addEventListener('online', () => {
  if (state.pointA && state.pointB && state.route?.isOfflineDirect) {
    setStatus('Сеть восстановлена — перестроение маршрута по дорогам...');
    calculateAndDrawRoute({ silentBanner: false, fitMap: false });
  }
});

// Offline Map Download (Petropavlovsk-Kamchatsky Grid zoom 11..15)
let offlineDownloadAbort = null;

if (isOfflineMapCached()) {
  btnDownloadMap.classList.add('is-cached');
  btnDownloadMap.textContent = 'КАРТА В КЭШЕ ✓ (ОБНОВИТЬ)';
}

btnDownloadMap.addEventListener('click', async () => {
  if (offlineDownloadAbort) {
    offlineDownloadAbort.abort();
    offlineDownloadAbort = null;
    btnDownloadMap.textContent = 'СКАЧАТЬ КАРТУ ПК (ОФЛАЙН)';
    offlineProgressTextEl.textContent = 'Загрузка отменена';
    return;
  }

  offlineDownloadAbort = new AbortController();
  offlineProgressWrapEl.classList.remove('hidden', 'is-done');
  offlineProgressBarEl.style.width = '0%';
  offlineProgressTextEl.textContent = 'Загрузка карты: 0%...';
  btnDownloadMap.textContent = 'ОТМЕНИТЬ ЗАГРУЗКУ';

  try {
    await downloadPetropavlovskOfflineMap({
      signal: offlineDownloadAbort.signal,
      onProgress: (pct) => {
        offlineProgressBarEl.style.width = `${pct}%`;
        offlineProgressTextEl.textContent =
          pct < 100 ? `Загрузка карты: ${pct}%...` : 'Карта в кэше';
      }
    });

    offlineProgressWrapEl.classList.add('is-done');
    offlineProgressTextEl.textContent = 'Карта в кэше';
    btnDownloadMap.classList.add('is-cached');
    btnDownloadMap.textContent = 'КАРТА В КЭШЕ ✓ (ОБНОВИТЬ)';
    showGtaBanner('КАРТА В КЭШЕ', 'ПЕТРОПАВЛОВСК-КАМЧАТСКИЙ ГОТОВ К ОФЛАЙНУ', 'finished');
  } catch (err) {
    if (err?.name !== 'AbortError') {
      offlineProgressTextEl.textContent = err?.message || 'Ошибка кэширования карты';
      btnDownloadMap.textContent = 'СКАЧАТЬ КАРТУ ПК (ОФЛАЙН)';
    }
  } finally {
    offlineDownloadAbort = null;
  }
});
