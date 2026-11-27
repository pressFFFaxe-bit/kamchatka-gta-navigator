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
import { findOfflineRoadRoute, loadRoadGraph } from './offlineRouter.js';

registerSW({ immediate: true });

const DEFAULT_CENTER = [158.64, 53.02]; // lon, lat
const START_ZOOM = 14.2;
const START_PITCH = 52;
const START_BEARING = 0;
const OFF_ROUTE_THRESHOLD_METERS = 45;
const ARRIVAL_RADIUS_METERS = 30;
const REROUTE_COOLDOWN_MS = 6000;
const MANUAL_CAMERA_RETURN_MS = 5000;
const LONG_PRESS_MS = 500;
const LAST_GPS_STORAGE_KEY = 'pk_last_gps_pos';

// Persistence for last valid GPS fix
function loadSavedGpsPos() {
  try {
    const raw = localStorage.getItem(LAST_GPS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.lat === 'number' &&
      typeof parsed?.lon === 'number' &&
      Number.isFinite(parsed.lat) &&
      Number.isFinite(parsed.lon)
    ) {
      return {
        lat: parsed.lat,
        lon: parsed.lon,
        heading: typeof parsed.heading === 'number' ? parsed.heading : 0
      };
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

function saveGpsPos(lat, lon, heading) {
  try {
    localStorage.setItem(
      LAST_GPS_STORAGE_KEY,
      JSON.stringify({ lat, lon, heading, ts: Date.now() })
    );
  } catch {
    // Ignore storage errors
  }
}

const initialGps = loadSavedGpsPos();
const initialCoord = initialGps ? [initialGps.lon, initialGps.lat] : DEFAULT_CENTER;

// DOM Elements
const hudPanelEl = document.getElementById('hud-panel');
const hudHeaderEl = document.getElementById('hud-header');
const btnCollapse = document.getElementById('btn-collapse');

const btnStyleMenu = document.getElementById('btn-style-menu');
const styleMenuLabelEl = document.getElementById('style-menu-label');
const styleSubmenuEl = document.getElementById('style-submenu');
const modeGtaBtn = document.getElementById('mode-gta');
const modeSatBtn = document.getElementById('mode-satellite');
const optBuildingsEl = document.getElementById('opt-buildings');
const optBlipsEl = document.getElementById('opt-blips');
const optPlacesEl = document.getElementById('opt-places');

const searchInput = document.getElementById('search-input');
const btnSearch = document.getElementById('btn-search');
const searchResultsEl = document.getElementById('search-results');

const labelBEl = document.getElementById('label-b');
const btnClear = document.getElementById('btn-clear');

const btnRouteDetails = document.getElementById('btn-route-details');
const routeDetailsBodyEl = document.getElementById('route-details-body');
const statDistanceEl = document.getElementById('stat-distance');
const statDurationEl = document.getElementById('stat-duration');
const routeStatusEl = document.getElementById('route-status');

const btnDownloadMap = document.getElementById('btn-download-map');
const offlineProgressWrapEl = document.getElementById('offline-progress-wrap');
const offlineProgressTextEl = document.getElementById('offline-progress-text');
const offlineProgressBarEl = document.getElementById('offline-progress-bar');

const btnDrive = document.getElementById('btn-drive');
const btnStop = document.getElementById('btn-stop');

const routeEtaPillEl = document.getElementById('route-eta-pill');
const etaPillDistEl = document.getElementById('eta-pill-dist');
const etaPillTimeEl = document.getElementById('eta-pill-time');

const confirmModalEl = document.getElementById('confirm-modal');
const confirmModalPlaceEl = document.getElementById('confirm-modal-place');
const btnConfirmGo = document.getElementById('btn-confirm-go');
const btnConfirmCancel = document.getElementById('btn-confirm-cancel');

const speedReadoutEl = document.getElementById('speed-readout');
const gtaBannerEl = document.getElementById('gta-banner');
const gtaBannerTitleEl = document.getElementById('gta-banner-title');
const gtaBannerSubEl = document.getElementById('gta-banner-sub');
const districtToastEl = document.getElementById('district-toast');

const btnGps = document.getElementById('btn-gps');
const btnToggleStreets = document.getElementById('btn-toggle-streets');
const btnToggle3d = document.getElementById('btn-toggle-3d');

// Application State
const state = {
  mapMode: 'gta', // 'gta' | 'satellite'
  terrainEnabled: true,
  streetLabelsVisible: true,
  buildingsVisible: true,
  blipsVisible: true,
  placesVisible: true,
  playerPos: {
    lat: initialCoord[1],
    lon: initialCoord[0],
    heading: initialGps ? initialGps.heading : 0
  },
  pointB: null, // { lat, lon, label }
  markerB: null,
  playerMarker: null,
  route: null, // { coordinates, distanceMeters, durationSeconds, isOfflineRoad }
  tripActive: false,
  wakeLock: null,
  manualCameraUntil: 0,
  manualReturnTimer: null,
  pendingTarget: null, // { lat, lon, label }
  gps: {
    active: false,
    watchId: null,
    lastCoord: null,
    lastRerouteAt: 0,
    rerouting: false
  },
  currentDistrict: null,
  districtTimer: null,
  bannerTimer: null
};

// Initialize MapLibre GL JS centered at last GPS position (or default on very first run)
const map = new maplibregl.Map({
  container: 'map',
  style: createGtaSaStyle(),
  center: initialCoord,
  zoom: START_ZOOM,
  pitch: START_PITCH,
  bearing: initialGps ? initialGps.heading : START_BEARING,
  maxPitch: 75,
  antialias: true
});

map.on('error', (e) => {
  if (e?.error) {
    console.warn('MapLibre warning:', e.error.message || e.error);
  }
});

// Geometry Helpers
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

/**
 * Estimates remaining route distance in meters from current position along polyline.
 */
function computeRemainingDistanceMeters(coord, route) {
  const coords = route?.coordinates;
  if (!coords || coords.length < 2) return route?.distanceMeters || 0;

  let closestIdx = 0;
  let closestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineMeters(coord, coords[i]);
    if (d < closestDist) {
      closestDist = d;
      closestIdx = i;
    }
  }

  let remaining = closestDist;
  for (let i = closestIdx; i < coords.length - 1; i++) {
    remaining += haversineMeters(coords[i], coords[i + 1]);
  }
  return remaining;
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

function updateEtaDisplays() {
  if (!state.route) {
    statDistanceEl.textContent = '— КМ';
    statDurationEl.textContent = '— МИН';
    routeEtaPillEl.classList.add('hidden');
    return;
  }

  const playerCoord = [state.playerPos.lon, state.playerPos.lat];
  const remMeters = state.tripActive
    ? Math.min(state.route.distanceMeters, computeRemainingDistanceMeters(playerCoord, state.route))
    : state.route.distanceMeters;
  const ratio = state.route.distanceMeters > 0 ? remMeters / state.route.distanceMeters : 1;
  const remSeconds = state.route.durationSeconds * ratio;

  const kmText = `${(remMeters / 1000).toFixed(2)} КМ`;
  const minText = formatDuration(remSeconds);

  statDistanceEl.textContent = kmText;
  statDurationEl.textContent = minText;
  etaPillDistEl.textContent = kmText;
  etaPillTimeEl.textContent = minText;

  const isCollapsed = hudPanelEl.classList.contains('is-collapsed');
  routeEtaPillEl.classList.toggle('hidden', !isCollapsed);
}

function setPanelCollapsed(collapsed) {
  hudPanelEl.classList.toggle('is-collapsed', collapsed);
  btnCollapse.textContent = collapsed ? '▸' : '▾';
  updateEtaDisplays();
}

function updateSpeedometer(speedMps) {
  if (typeof speedMps === 'number' && Number.isFinite(speedMps) && speedMps >= 0) {
    speedReadoutEl.textContent = String(Math.round(speedMps * 3.6));
  } else {
    speedReadoutEl.textContent = '0';
  }
}

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
    // Ignore
  } finally {
    state.wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (state.tripActive && document.visibilityState === 'visible') {
    acquireWakeLock();
  }
});

// Custom Markers: GTA SA White 4-pointed Cross (GPS Player) & Target Crosshair (Point B)
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
}

function attachTargetMarker(lat, lon) {
  if (state.markerB) {
    state.markerB.setLngLat([lon, lat]);
    return state.markerB;
  }
  state.markerB = new maplibregl.Marker({
    element: createTargetPinElement(),
    anchor: 'center',
    draggable: false
  })
    .setLngLat([lon, lat])
    .addTo(map);
  return state.markerB;
}

// Map Load + Warmup Offline Road Graph
map.on('load', () => {
  registerGtaPoiBlips(map);
  ensurePlayerMarker(initialCoord, state.playerPos.heading);
  // Preload pk-roads.json into memory in background if cached
  loadRoadGraph().catch(() => {});
  // Automatically start GPS tracking on launch
  startGpsTracking();
});

map.on('styleimagemissing', () => {
  registerGtaPoiBlips(map);
});

// Destination Setting (Point B only; Origin is always live GPS playerPos)
async function setDestination(lat, lon, label = null, flyToRoute = true) {
  const displayLabel = label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  state.pointB = { lat, lon, label: displayLabel };
  labelBEl.textContent = displayLabel;
  attachTargetMarker(lat, lon);

  if (!label) {
    reverseGeocode(lat, lon).then((resolved) => {
      if (state.pointB && state.pointB.lat === lat && state.pointB.lon === lon) {
        state.pointB.label = resolved;
        labelBEl.textContent = resolved;
      }
    });
  }

  await calculateAndDrawRoute({ silentBanner: false, fitMap: flyToRoute });
}

function fitRouteBounds(coordinates) {
  const bounds = new maplibregl.LngLatBounds();
  for (const c of coordinates) bounds.extend(c);
  const isMobile = window.innerWidth <= 768;
  map.fitBounds(bounds, {
    padding: isMobile
      ? { top: 150, bottom: 95, left: 32, right: 32 }
      : { top: 80, bottom: 95, left: 400, right: 80 },
    pitch: state.terrainEnabled ? 48 : 0,
    maxZoom: 15.5,
    duration: 850
  });
}

async function calculateAndDrawRoute({ silentBanner = false, fitMap = true } = {}) {
  if (!state.pointB) return;

  const origin = { lat: state.playerPos.lat, lon: state.playerPos.lon };
  const dest = state.pointB;

  if (!silentBanner) {
    setStatus('Расчёт маршрута...');
    btnDrive.disabled = true;
    btnStop.disabled = !state.tripActive;
  }

  let result = null;
  let usedOfflineAStar = false;

  if (navigator.onLine !== false) {
    try {
      result = await fetchDrivingRoute(origin, dest);
    } catch (err) {
      console.warn('OSRM unavailable, falling back to offline A* graph:', err?.message || err);
    }
  }

  if (!result) {
    try {
      result = await findOfflineRoadRoute(origin, dest);
      usedOfflineAStar = true;
    } catch (offlineErr) {
      console.error(offlineErr);
      setStatus(offlineErr?.message || 'Ошибка построения маршрута', true);
      if (!silentBanner) clearRouteLayer();
      return;
    }
  }

  const coordinates = result.geometry.coordinates;
  state.route = {
    coordinates,
    distanceMeters: result.distanceMeters,
    durationSeconds: result.durationSeconds,
    isOfflineRoad: usedOfflineAStar
  };

  const routeSource = map.getSource('route');
  if (routeSource) {
    routeSource.setData({
      type: 'Feature',
      geometry: result.geometry
    });
  }

  updateEtaDisplays();

  const kmStr = `${(result.distanceMeters / 1000).toFixed(2)} КМ`;
  const durStr = formatDuration(result.durationSeconds);

  setStatus(
    usedOfflineAStar
      ? 'Офлайн-маршрут по дорогам (A*)'
      : state.tripActive
        ? 'Поездка активна — ведение по маршруту'
        : 'Маршрут готов. Нажмите «ПОЕХАЛИ».'
  );

  btnDrive.disabled = state.tripActive;
  btnStop.disabled = !state.tripActive;

  if (fitMap) fitRouteBounds(coordinates);

  if (!silentBanner) {
    showGtaBanner(
      usedOfflineAStar ? 'ОФЛАЙН-МАРШРУТ (A*)' : 'МАРШРУТ ПРОЛОЖЕН',
      `${kmStr} • ${durStr}`,
      'route'
    );
  }
}

function clearRouteLayer() {
  state.route = null;
  const routeSource = map.getSource('route');
  if (routeSource) {
    routeSource.setData({ type: 'FeatureCollection', features: [] });
  }
  updateEtaDisplays();
  btnDrive.disabled = true;
  btnStop.disabled = !state.tripActive;
}

function clearDestinationAndRoute() {
  state.pointB = null;
  labelBEl.textContent = 'Удерживайте карту или найдите';
  if (state.markerB) {
    state.markerB.remove();
    state.markerB = null;
  }
  clearRouteLayer();
}

// Active Trip («ПОЕХАЛИ» / «СТОП») + Auto-Collapse + Wake Lock
async function startTrip() {
  if (!state.route) return;
  state.tripActive = true;
  state.currentDistrict = null;
  state.manualCameraUntil = 0;
  clearTimeout(state.manualReturnTimer);

  btnDrive.disabled = true;
  btnStop.disabled = false;

  setPanelCollapsed(true);
  await acquireWakeLock();

  if (!state.gps.active) {
    startGpsTracking();
  }

  centerCameraOnPlayer(true);
  setStatus(
    state.route.isOfflineRoad
      ? 'Офлайн-поездка активна (A*)'
      : 'Поездка активна — ведение по маршруту'
  );
  updateEtaDisplays();
}

async function stopTrip() {
  state.tripActive = false;
  btnStop.disabled = true;
  btnDrive.disabled = !state.route;
  await releaseWakeLock();

  map.easeTo({
    pitch: state.terrainEnabled ? START_PITCH : 0,
    duration: 500
  });
  setStatus(
    state.route
      ? 'Поездка остановлена. Нажмите «ПОЕХАЛИ».'
      : 'Удерживайте точку на карте (0.5 сек) или введите адрес'
  );
  updateEtaDisplays();
}

async function completeRouteOnArrival() {
  state.tripActive = false;
  btnStop.disabled = true;
  await releaseWakeLock();
  clearDestinationAndRoute();
  showGtaBanner('ЦЕЛЬ ДОСТИГНУТА', 'ВЫ ПРИБЫЛИ В ПУНКТ НАЗНАЧЕНИЯ', 'finished');
  setStatus('Цель достигнута! Удерживайте карту для нового маршрута.');
  map.easeTo({
    pitch: state.terrainEnabled ? START_PITCH : 0,
    duration: 600
  });
}

btnDrive.addEventListener('click', startTrip);
btnStop.addEventListener('click', stopTrip);

// Free Camera Pause / Auto-Resume (5s after user stops panning/zooming)
function pauseCameraAutoFollow(durationMs = 60000) {
  state.manualCameraUntil = Date.now() + durationMs;
  clearTimeout(state.manualReturnTimer);
}

function scheduleCameraResume() {
  clearTimeout(state.manualReturnTimer);
  state.manualCameraUntil = Date.now() + MANUAL_CAMERA_RETURN_MS;
  state.manualReturnTimer = setTimeout(() => {
    state.manualCameraUntil = 0;
    if (state.gps.active) {
      centerCameraOnPlayer(false);
    }
  }, MANUAL_CAMERA_RETURN_MS);
}

function centerCameraOnPlayer(immediatePitch = false) {
  const coord = [state.playerPos.lon, state.playerPos.lat];
  const pitch = state.terrainEnabled ? (state.tripActive || state.gps.active ? 62 : START_PITCH) : 0;
  map.easeTo({
    center: coord,
    bearing: state.playerPos.heading,
    pitch: immediatePitch ? (state.terrainEnabled ? 62 : 0) : pitch,
    zoom: Math.max(map.getZoom(), 15.8),
    duration: 600
  });
}

map.on('dragstart', (e) => {
  if (e.originalEvent) pauseCameraAutoFollow(60000);
});
map.on('dragend', (e) => {
  if (e.originalEvent) scheduleCameraResume();
});
map.on('touchstart', (e) => {
  if (e.originalEvent) pauseCameraAutoFollow(60000);
});
map.on('touchend', (e) => {
  if (e.originalEvent) scheduleCameraResume();
});
map.on('wheel', () => {
  pauseCameraAutoFollow(MANUAL_CAMERA_RETURN_MS);
  scheduleCameraResume();
});

// Real GPS Tracking (auto-started, persists last coordinate in localStorage)
function stopGpsTracking(updateStatusText = true) {
  if (state.gps.watchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(state.gps.watchId);
  }
  state.gps.watchId = null;
  state.gps.active = false;
  state.gps.rerouting = false;
  setToggleState(btnGps, false);
  updateSpeedometer(0);

  if (updateStatusText) {
    setStatus('GPS отключён — показана последняя фиксация');
  }
}

async function maybeRerouteFromGps(lat, lon) {
  if (!state.tripActive || !state.pointB || !state.route?.coordinates?.length) return;
  if (state.gps.rerouting) return;

  const deviationMeters = distanceToPolylineMeters([lon, lat], state.route.coordinates);
  const shouldUpgradeOnline = state.route.isOfflineRoad && navigator.onLine !== false;
  if (!shouldUpgradeOnline && deviationMeters <= OFF_ROUTE_THRESHOLD_METERS) return;

  const now = Date.now();
  if (now - state.gps.lastRerouteAt < REROUTE_COOLDOWN_MS) return;

  state.gps.lastRerouteAt = now;
  state.gps.rerouting = true;
  setStatus(
    shouldUpgradeOnline
      ? 'Сеть появилась — обновление по OSRM...'
      : `Сход с маршрута (${Math.round(deviationMeters)} м) — перестроение...`
  );

  try {
    await calculateAndDrawRoute({ silentBanner: true, fitMap: false });
  } finally {
    state.gps.rerouting = false;
  }
}

function startGpsTracking() {
  if (!('geolocation' in navigator)) {
    setToggleState(btnGps, false);
    setStatus('Геолокация не поддерживается браузером', true);
    return;
  }

  state.gps.active = true;
  state.gps.lastCoord = null;
  setToggleState(btnGps, true);

  state.gps.watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      if (!state.gps.active) return;

      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const coord = [lon, lat];

      updateSpeedometer(pos.coords.speed);

      let nextHeading = state.playerPos.heading;
      if (typeof pos.coords.heading === 'number' && Number.isFinite(pos.coords.heading)) {
        nextHeading = pos.coords.heading;
      } else if (state.gps.lastCoord) {
        const moved = haversineMeters(state.gps.lastCoord, coord);
        if (moved > 2) {
          nextHeading = bearingDegrees(state.gps.lastCoord, coord);
        }
      }
      const smoothHeading = lerpAngle(state.playerPos.heading, nextHeading, 0.55);
      state.gps.lastCoord = coord;

      state.playerPos = { lat, lon, heading: smoothHeading };
      saveGpsPos(lat, lon, smoothHeading);

      ensurePlayerMarker(coord, smoothHeading);
      checkDistrictEntry(lat, lon);

      // Respect manual camera panning/zooming pause
      if (Date.now() >= state.manualCameraUntil) {
        map.easeTo({
          center: coord,
          bearing: smoothHeading,
          pitch: state.terrainEnabled ? (state.tripActive ? 62 : START_PITCH) : 0,
          zoom: Math.max(map.getZoom(), state.tripActive ? 16.0 : START_ZOOM),
          duration: 500
        });
      }

      if (state.pointB) {
        const distToGoal = haversineMeters(coord, [state.pointB.lon, state.pointB.lat]);
        if (distToGoal < ARRIVAL_RADIUS_METERS) {
          await completeRouteOnArrival();
          return;
        }
      }

      if (state.route) {
        updateEtaDisplays();
      }

      if (state.tripActive) {
        await maybeRerouteFromGps(lat, lon);
      } else if (state.pointB && !state.route) {
        await calculateAndDrawRoute({ silentBanner: false, fitMap: false });
      }
    },
    (err) => {
      console.warn('Geolocation error:', err);
      // Keep cursor at last saved valid coordinate!
      stopGpsTracking(false);
      setStatus('Сигнал GPS недоступен — курсор на последней позиции');
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 10000
    }
  );
}

// Long-Press (~500ms) to Choose Destination + Confirmation Dialog (NO single-click placement!)
const mapCanvas = map.getCanvas();
let longPressTimer = null;
let longPressOrigin = null;

function cancelLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressOrigin = null;
}

function openDestinationConfirm(lat, lon) {
  pauseCameraAutoFollow(10000);
  state.pendingTarget = { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
  confirmModalPlaceEl.textContent = state.pendingTarget.label;
  confirmModalEl.classList.remove('hidden');

  if (navigator.vibrate) {
    try {
      navigator.vibrate(40);
    } catch {
      // Ignore vibration errors
    }
  }

  reverseGeocode(lat, lon).then((resolved) => {
    if (
      state.pendingTarget &&
      state.pendingTarget.lat === lat &&
      state.pendingTarget.lon === lon
    ) {
      state.pendingTarget.label = resolved;
      confirmModalPlaceEl.textContent = resolved;
    }
  });
}

mapCanvas.addEventListener('pointerdown', (e) => {
  if (e.isPrimary === false) {
    cancelLongPress();
    return;
  }
  if (e.button && e.button !== 0) return;

  cancelLongPress();
  const rect = mapCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  longPressOrigin = { x, y };

  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    if (!longPressOrigin) return;
    const lngLat = map.unproject([longPressOrigin.x, longPressOrigin.y]);
    longPressOrigin = null;
    openDestinationConfirm(lngLat.lat, lngLat.lng);
  }, LONG_PRESS_MS);
});

mapCanvas.addEventListener('pointermove', (e) => {
  if (!longPressOrigin || !longPressTimer) return;
  const rect = mapCanvas.getBoundingClientRect();
  const dx = e.clientX - rect.left - longPressOrigin.x;
  const dy = e.clientY - rect.top - longPressOrigin.y;
  if (Math.hypot(dx, dy) > 10) {
    cancelLongPress();
  }
});

mapCanvas.addEventListener('pointerup', cancelLongPress);
mapCanvas.addEventListener('pointercancel', cancelLongPress);
mapCanvas.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length > 1) cancelLongPress();
  },
  { passive: true }
);

btnConfirmGo.addEventListener('click', async () => {
  const target = state.pendingTarget;
  state.pendingTarget = null;
  confirmModalEl.classList.add('hidden');
  if (!target) return;

  await setDestination(target.lat, target.lon, target.label, false);
  await startTrip();
});

btnConfirmCancel.addEventListener('click', () => {
  state.pendingTarget = null;
  confirmModalEl.classList.add('hidden');
});

// POI Blips Popup (single click on POI icon only)
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

  cardEl.querySelector('.poi-card__btn').addEventListener('click', async () => {
    if (activePoiPopup) {
      activePoiPopup.remove();
      activePoiPopup = null;
    }
    await setDestination(coords[1], coords[0], placeName, true);
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

// Single click ONLY opens POI blip cards (never places Point B on empty map)
map.on('click', (e) => {
  if (e.originalEvent?.target?.closest('.maplibregl-marker, .maplibregl-popup')) return;
  const poiHits = map.getLayer('poi-blips')
    ? map.queryRenderedFeatures(e.point, { layers: ['poi-blips'] })
    : [];
  if (poiHits.length > 0) {
    openPoiPopup(poiHits[0], e.lngLat);
  }
});

// Top Sheet Swipe Up/Down + Click Collapse
let sheetTouchStartY = null;
let sheetTouchCurrentY = null;

hudPanelEl.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) return;
    if (e.target.closest('.search-results, input, .offline-progress')) return;
    sheetTouchStartY = e.touches[0].clientY;
    sheetTouchCurrentY = sheetTouchStartY;
  },
  { passive: true }
);

hudPanelEl.addEventListener(
  'touchmove',
  (e) => {
    if (sheetTouchStartY === null || e.touches.length !== 1) return;
    sheetTouchCurrentY = e.touches[0].clientY;
  },
  { passive: true }
);

hudPanelEl.addEventListener('touchend', () => {
  if (sheetTouchStartY === null || sheetTouchCurrentY === null) return;
  const deltaY = sheetTouchCurrentY - sheetTouchStartY;
  if (deltaY < -36) {
    setPanelCollapsed(true);
  } else if (deltaY > 36) {
    setPanelCollapsed(false);
  }
  sheetTouchStartY = null;
  sheetTouchCurrentY = null;
});

hudHeaderEl.addEventListener('click', (e) => {
  if (e.target === btnCollapse) return;
  setPanelCollapsed(!hudPanelEl.classList.contains('is-collapsed'));
});

btnCollapse.addEventListener('click', (e) => {
  e.stopPropagation();
  setPanelCollapsed(!hudPanelEl.classList.contains('is-collapsed'));
});

// Compact Map Style Menu & Options
btnStyleMenu.addEventListener('click', () => {
  const isHidden = styleSubmenuEl.classList.toggle('hidden');
  btnStyleMenu.setAttribute('aria-expanded', String(!isHidden));
});

function setMapMode(mode) {
  state.mapMode = mode;
  modeGtaBtn.classList.toggle('is-active', mode === 'gta');
  modeSatBtn.classList.toggle('is-active', mode === 'satellite');
  styleMenuLabelEl.textContent =
    mode === 'gta' ? 'СТИЛЬ КАРТЫ: GTA SA' : 'СТИЛЬ КАРТЫ: СПУТНИК';

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

optBuildingsEl.addEventListener('change', () => {
  state.buildingsVisible = optBuildingsEl.checked;
  if (map.getLayer('building-3d')) {
    map.setLayoutProperty('building-3d', 'visibility', state.buildingsVisible ? 'visible' : 'none');
  }
});

optBlipsEl.addEventListener('change', () => {
  state.blipsVisible = optBlipsEl.checked;
  if (map.getLayer('poi-blips')) {
    map.setLayoutProperty('poi-blips', 'visibility', state.blipsVisible ? 'visible' : 'none');
  }
});

optPlacesEl.addEventListener('change', () => {
  state.placesVisible = optPlacesEl.checked;
  const vis = state.placesVisible ? 'visible' : 'none';
  for (const id of ['place-labels-districts', 'place-labels-city', 'peak-labels', 'water-labels']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
});

// Search Handling (sets Point B)
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
      '<li><span class="search-results__meta">Офлайн: удерживайте точку на карте (0.5 сек) для выбора цели</span></li>';
    setStatus('Нет сети — удерживайте точку на карте для выбора цели');
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
      setDestination(item.lat, item.lon, item.label, true);
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

// Route Details & Clear
btnRouteDetails.addEventListener('click', () => {
  const isHidden = routeDetailsBodyEl.classList.toggle('hidden');
  btnRouteDetails.setAttribute('aria-expanded', String(!isHidden));
});

btnClear.addEventListener('click', async () => {
  if (state.tripActive) {
    await stopTrip();
  }
  clearDestinationAndRoute();
  setStatus('Удерживайте точку на карте (0.5 сек) или введите адрес');
});

// Bottom-Right Visual Toggle Switches
function setToggleState(btn, isOn) {
  btn.classList.toggle('is-on', isOn);
  btn.setAttribute('aria-pressed', String(isOn));
}

btnGps.addEventListener('click', () => {
  if (state.gps.active) {
    if (Date.now() < state.manualCameraUntil) {
      // Immediately resume auto-centering on player when panned away
      state.manualCameraUntil = 0;
      clearTimeout(state.manualReturnTimer);
      centerCameraOnPlayer(false);
    } else if (state.tripActive) {
      stopTrip().then(() => stopGpsTracking(true));
    } else {
      stopGpsTracking(true);
    }
  } else {
    state.manualCameraUntil = 0;
    startGpsTracking();
    centerCameraOnPlayer(false);
  }
});

btnToggleStreets.addEventListener('click', () => {
  state.streetLabelsVisible = !state.streetLabelsVisible;
  setToggleState(btnToggleStreets, state.streetLabelsVisible);

  const visibility = state.streetLabelsVisible ? 'visible' : 'none';
  for (const layerId of ['road-labels-major', 'road-labels-streets']) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  }
});

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
  setToggleState(btnToggle3d, state.terrainEnabled);

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

// Auto-upgrade offline A* route to OSRM when back online
window.addEventListener('online', () => {
  if (state.pointB && state.route?.isOfflineRoad) {
    setStatus('Сеть восстановлена — обновление маршрута через OSRM...');
    calculateAndDrawRoute({ silentBanner: true, fitMap: false });
  }
});

// Offline Map Download (Petropavlovsk-Kamchatsky Grid zoom 11..15 + pk-roads.json)
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
    // Also warm up local road graph JSON
    loadRoadGraph().catch(() => {});

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
    showGtaBanner('КАРТА В КЭШЕ', 'ГОРОД И ДОРОГИ ГОТОВЫ К ОФЛАЙНУ', 'finished');
  } catch (err) {
    if (err?.name !== 'AbortError') {
      offlineProgressTextEl.textContent = err?.message || 'Ошибка кэширования карты';
      btnDownloadMap.textContent = 'СКАЧАТЬ КАРТУ ПК (ОФЛАЙН)';
    }
  } finally {
    offlineDownloadAbort = null;
  }
});
