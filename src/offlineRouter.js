// Offline A* road router using pre-built Petropavlovsk-Kamchatsky OSM graph (pk-roads.json)

const DEG2RAD = Math.PI / 180;
const MAX_SPEED_MPS = 70 / 3.6;

let cachedGraph = null;
let graphPromise = null;

function haversineMeters(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(node, f) {
    const arr = this.items;
    arr.push({ node, f });
    let i = arr.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (arr[p].f <= arr[i].f) break;
      const tmp = arr[p];
      arr[p] = arr[i];
      arr[i] = tmp;
      i = p;
    }
  }

  pop() {
    const arr = this.items;
    const top = arr[0];
    const last = arr.pop();
    if (arr.length > 0) {
      arr[0] = last;
      let i = 0;
      const n = arr.length;
      while (true) {
        let best = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < n && arr[l].f < arr[best].f) best = l;
        if (r < n && arr[r].f < arr[best].f) best = r;
        if (best === i) break;
        const tmp = arr[i];
        arr[i] = arr[best];
        arr[best] = tmp;
        i = best;
      }
    }
    return top;
  }
}

export async function loadRoadGraph() {
  if (cachedGraph) return cachedGraph;
  if (!graphPromise) {
    graphPromise = fetch('./pk-roads.json')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load pk-roads.json (${res.status})`);
        return res.json();
      })
      .then((data) => {
        cachedGraph = data;
        return data;
      })
      .catch((err) => {
        graphPromise = null;
        throw err;
      });
  }
  return graphPromise;
}

function findNearestNode(graph, lon, lat, requireOutgoing = false) {
  const { nodes, adj } = graph;
  const count = nodes.length / 2;
  const cosLat = Math.cos(lat * DEG2RAD);
  let bestIdx = -1;
  let bestDistSq = Infinity;

  for (let i = 0; i < count; i++) {
    if (requireOutgoing && (!adj[i] || adj[i].length === 0)) continue;
    const dx = (nodes[i * 2] - lon) * cosLat;
    const dy = nodes[i * 2 + 1] - lat;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function runAStar(graph, startIdx, goalIdx) {
  const { nodes, adj } = graph;
  const nodeCount = nodes.length / 2;
  const goalLon = nodes[goalIdx * 2];
  const goalLat = nodes[goalIdx * 2 + 1];

  const gScore = new Float64Array(nodeCount);
  gScore.fill(Infinity);
  const distScore = new Float64Array(nodeCount);
  const parent = new Int32Array(nodeCount);
  parent.fill(-1);
  const closed = new Uint8Array(nodeCount);

  gScore[startIdx] = 0;
  distScore[startIdx] = 0;

  const heap = new MinHeap();
  const h0 =
    haversineMeters(nodes[startIdx * 2], nodes[startIdx * 2 + 1], goalLon, goalLat) /
    MAX_SPEED_MPS;
  heap.push(startIdx, h0);

  while (heap.size > 0) {
    const { node: u } = heap.pop();
    if (u === goalIdx) {
      return { parent, distMeters: distScore[goalIdx], durationSeconds: gScore[goalIdx] };
    }
    if (closed[u]) continue;
    closed[u] = 1;

    const edges = adj[u];
    if (!edges) continue;

    const uTime = gScore[u];
    const uDist = distScore[u];

    for (let i = 0; i < edges.length; i += 3) {
      const v = edges[i];
      if (closed[v]) continue;
      const distM = edges[i + 1];
      const timeS = edges[i + 2];
      const tentativeG = uTime + timeS;

      if (tentativeG < gScore[v]) {
        gScore[v] = tentativeG;
        distScore[v] = uDist + distM;
        parent[v] = u;
        const h =
          haversineMeters(nodes[v * 2], nodes[v * 2 + 1], goalLon, goalLat) /
          MAX_SPEED_MPS;
        heap.push(v, tentativeG + h);
      }
    }
  }
  return null;
}

/**
 * Computes a driving route strictly along Petropavlovsk-Kamchatsky streets
 * using A* on the local pk-roads.json graph.
 */
export async function findOfflineRoadRoute(pointA, pointB) {
  const graph = await loadRoadGraph();
  const { nodes } = graph;

  const startIdx = findNearestNode(graph, pointA.lon, pointA.lat, true);
  const goalIdx = findNearestNode(graph, pointB.lon, pointB.lat, false);

  if (startIdx < 0 || goalIdx < 0) {
    throw new Error('Дорожный граф не содержит ближайших узлов');
  }

  if (startIdx === goalIdx) {
    const coords = [
      [pointA.lon, pointA.lat],
      [nodes[startIdx * 2], nodes[startIdx * 2 + 1]],
      [pointB.lon, pointB.lat]
    ];
    const dist = Math.max(1, haversineMeters(pointA.lon, pointA.lat, pointB.lon, pointB.lat));
    return {
      geometry: { type: 'LineString', coordinates: coords },
      distanceMeters: dist,
      durationSeconds: dist / 8.33,
      isOfflineRoad: true
    };
  }

  let res = runAStar(graph, startIdx, goalIdx);
  if (!res) {
    // Fallback: snap goal to a node with outgoing edges inside the bidirectional core
    const altGoal = findNearestNode(graph, pointB.lon, pointB.lat, true);
    if (altGoal >= 0 && altGoal !== goalIdx) {
      res = runAStar(graph, startIdx, altGoal);
      if (res) {
        return buildResult(nodes, res.parent, startIdx, altGoal, pointA, pointB, res);
      }
    }
    throw new Error('Офлайн-маршрут по дорогам между выбранными точками не найден');
  }

  return buildResult(nodes, res.parent, startIdx, goalIdx, pointA, pointB, res);
}

function buildResult(nodes, parent, startIdx, endIdx, pointA, pointB, res) {
  const pathIndices = [];
  let cur = endIdx;
  while (cur !== -1) {
    pathIndices.push(cur);
    if (cur === startIdx) break;
    cur = parent[cur];
  }
  pathIndices.reverse();

  const coordinates = [];
  const firstNode = [nodes[pathIndices[0] * 2], nodes[pathIndices[0] * 2 + 1]];
  if (haversineMeters(pointA.lon, pointA.lat, firstNode[0], firstNode[1]) > 12) {
    coordinates.push([pointA.lon, pointA.lat]);
  }
  for (const idx of pathIndices) {
    coordinates.push([nodes[idx * 2], nodes[idx * 2 + 1]]);
  }
  const lastNode = [
    nodes[pathIndices[pathIndices.length - 1] * 2],
    nodes[pathIndices[pathIndices.length - 1] * 2 + 1]
  ];
  if (haversineMeters(lastNode[0], lastNode[1], pointB.lon, pointB.lat) > 12) {
    coordinates.push([pointB.lon, pointB.lat]);
  }

  return {
    geometry: { type: 'LineString', coordinates },
    distanceMeters: res.distMeters,
    durationSeconds: res.durationSeconds,
    isOfflineRoad: true
  };
}
