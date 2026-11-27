import fs from 'node:fs';
import path from 'node:path';

const BBOX = '52.95,158.53,53.13,158.76';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const QUERY = `
[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${BBOX});
);
out body;
>;
out skel qt;
`.trim();

const SPEED_BY_HIGHWAY = {
  motorway: 70,
  trunk: 70,
  primary: 60,
  motorway_link: 55,
  trunk_link: 55,
  secondary: 50,
  primary_link: 45,
  tertiary: 45,
  secondary_link: 40,
  unclassified: 35,
  tertiary_link: 35,
  residential: 30,
  living_street: 20
};

const DEG2RAD = Math.PI / 180;
function haversineMeters(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function round5(n) {
  return Math.round(n * 1e5) / 1e5;
}

async function fetchOverpass() {
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      console.log(`Fetching OSM road network from ${url}...`);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'KamchatkaGTANavigator/1.0'
        },
        body: `data=${encodeURIComponent(QUERY)}`
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      console.warn(`Failed ${url}:`, err.message);
    }
  }
  throw new Error('All Overpass endpoints failed');
}

async function main() {
  const osm = await fetchOverpass();
  const osmNodes = new Map();
  const ways = [];

  for (const el of osm.elements || []) {
    if (el.type === 'node') {
      osmNodes.set(el.id, [round5(el.lon), round5(el.lat)]);
    } else if (el.type === 'way' && Array.isArray(el.nodes) && el.nodes.length >= 2) {
      ways.push(el);
    }
  }

  console.log(`Raw OSM nodes: ${osmNodes.size}, ways: ${ways.length}`);

  // Build undirected connectivity first to keep only the main connected road component
  const undirected = new Map();
  const addUndir = (a, b) => {
    if (!undirected.has(a)) undirected.set(a, []);
    if (!undirected.has(b)) undirected.set(b, []);
    undirected.get(a).push(b);
    undirected.get(b).push(a);
  };

  for (const w of ways) {
    for (let i = 0; i < w.nodes.length - 1; i++) {
      const a = w.nodes[i];
      const b = w.nodes[i + 1];
      if (osmNodes.has(a) && osmNodes.has(b) && a !== b) {
        addUndir(a, b);
      }
    }
  }

  // Find connected components via BFS
  const visited = new Set();
  let mainComponent = new Set();
  for (const startId of undirected.keys()) {
    if (visited.has(startId)) continue;
    const comp = new Set([startId]);
    const stack = [startId];
    visited.add(startId);
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const nxt of undirected.get(cur) || []) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          comp.add(nxt);
          stack.push(nxt);
        }
      }
    }
    if (comp.size > mainComponent.size) {
      mainComponent = comp;
    }
  }

  console.log(`Main connected component nodes: ${mainComponent.size}`);

  // Map OSM node IDs in main component to dense indices 0..N-1
  const idToIdx = new Map();
  const nodes = []; // flat [lon0, lat0, lon1, lat1, ...]
  for (const osmId of mainComponent) {
    const coord = osmNodes.get(osmId);
    if (!coord) continue;
    const idx = nodes.length / 2;
    idToIdx.set(osmId, idx);
    nodes.push(coord[0], coord[1]);
  }

  const nodeCount = nodes.length / 2;
  const adj = Array.from({ length: nodeCount }, () => []);
  let directedEdges = 0;

  const pushEdge = (u, v, distM, timeS) => {
    // Format: [toIdx, distMetersRounded, timeSecondsTenths]
    adj[u].push(v, Math.max(1, Math.round(distM)), Math.max(0.1, Math.round(timeS * 10) / 10));
    directedEdges++;
  };

  for (const w of ways) {
    const tags = w.tags || {};
    const hw = tags.highway;
    const speedKmh = SPEED_BY_HIGHWAY[hw] || 30;
    const speedMps = speedKmh / 3.6;

    const oneway = tags.oneway;
    const isRoundabout = tags.junction === 'roundabout' || tags.junction === 'circular';
    const forwardOnly = oneway === 'yes' || oneway === '1' || oneway === 'true' || isRoundabout;
    const reverseOnly = oneway === '-1';

    for (let i = 0; i < w.nodes.length - 1; i++) {
      const u = idToIdx.get(w.nodes[i]);
      const v = idToIdx.get(w.nodes[i + 1]);
      if (u === undefined || v === undefined || u === v) continue;

      const distM = haversineMeters(
        nodes[u * 2],
        nodes[u * 2 + 1],
        nodes[v * 2],
        nodes[v * 2 + 1]
      );
      const timeS = distM / speedMps;

      if (reverseOnly) {
        pushEdge(v, u, distM, timeS);
      } else if (forwardOnly) {
        pushEdge(u, v, distM, timeS);
      } else {
        pushEdge(u, v, distM, timeS);
        pushEdge(v, u, distM, timeS);
      }
    }
  }

  const outPath = path.resolve('public', 'pk-roads.json');
  const payload = JSON.stringify({
    bbox: [52.95, 158.53, 53.13, 158.76],
    nodes,
    adj
  });

  fs.writeFileSync(outPath, payload, 'utf8');
  const sizeMb = (Buffer.byteLength(payload, 'utf8') / (1024 * 1024)).toFixed(2);
  console.log(`Saved ${outPath}: ${nodeCount} nodes, ${directedEdges} directed edges, ${sizeMb} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
