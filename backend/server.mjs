import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { commandSumoSimulation, startSumoSimulation, stopAllSumoSimulations, stopSumoSimulation, sumoStatus } from './sumo-engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cacheFile = resolve(here, 'data', 'models.json');
const port = Number(process.env.PORT || process.env.API_PORT || 8000);
const host = process.env.HOST || '127.0.0.1';
const geocodeCache = new Map();
const models = new Map();
const simulations = new Map();
const geocodingUrl = process.env.GEOCODING_URL || 'https://geocoding-api.open-meteo.com/v1/search';
const overpassUrl = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const routingUrl = (process.env.ROUTING_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
const weatherUrl = process.env.WEATHER_URL || 'https://api.open-meteo.com/v1/forecast';
const weatherCache = new Map();
const buildingCache = new Map();
let lastOverpassAt = 0;
const MAX_CLOSURE_DURATION_MINUTES = 525_600; // 365-day planning horizon

await mkdir(dirname(cacheFile), { recursive: true });
try {
  const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
  for (const model of saved) models.set(model.id, model);
} catch { /* A missing cache is normal on first run. */ }

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function haversine(a, b) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function pointAt(road, progress) {
  const coords = road.coordinates;
  if (!coords?.length) return [0, 0];
  if (coords.length === 1) return coords[0];
  const target = Math.max(0, Math.min(.99999, progress)) * road.lengthMeters;
  let travelled = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const distance = haversine(coords[i], coords[i + 1]);
    if (travelled + distance >= target) {
      const part = distance ? (target - travelled) / distance : 0;
      return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * part, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * part];
    }
    travelled += distance;
  }
  return coords.at(-1);
}

async function geocode(term) {
  const key = term.toLocaleLowerCase();
  const cached = geocodeCache.get(key);
  if (cached && Date.now() - cached.savedAt < 6 * 60 * 60 * 1000) return cached.results;
  const url = new URL(geocodingUrl);
  url.searchParams.set('name', term);
  url.searchParams.set('count', '5');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Place search service returned ${response.status}.`);
  const payload = await response.json();
  const results = (payload.results || []).map(item => ({
    id: item.id,
    name: item.name,
    latitude: item.latitude,
    longitude: item.longitude,
    country: item.country || '',
    admin1: item.admin1 || '',
    feature_code: item.feature_code || '',
  }));
  geocodeCache.set(key, { results, savedAt: Date.now() });
  return results;
}

async function getWeather(latitude, longitude) {
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.savedAt < 10 * 60_000) return cached.data;
  const endpoint = new URL(weatherUrl);
  endpoint.searchParams.set('latitude', String(latitude));
  endpoint.searchParams.set('longitude', String(longitude));
  endpoint.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m');
  endpoint.searchParams.set('timezone', 'auto');
  endpoint.searchParams.set('timeformat', 'unixtime');
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Weather service returned ${response.status}.`);
  const payload = await response.json();
  const data = { current: payload.current, current_units: payload.current_units, timezone: payload.timezone, fetchedAt: new Date().toISOString(), provider: 'Open-Meteo weather model', latitude: payload.latitude, longitude: payload.longitude };
  weatherCache.set(key, { data, savedAt: Date.now() });
  return data;
}

function osmHeightMeters(value) {
  const raw = String(value ?? '').trim();
  const height = Number.parseFloat(raw);
  if (!Number.isFinite(height)) return null;
  return /\b(?:ft|feet|foot)\b|[′']/i.test(raw) ? height * 0.3048 : height;
}

async function getBuildings(latitude, longitude, radiusMeters) {
  const radius = Math.max(400, Math.min(1500, Math.round(Number(radiusMeters) || 800)));
  const key = `${latitude.toFixed(4)},${longitude.toFixed(4)},${radius}`;
  const cached = buildingCache.get(key);
  if (cached && Date.now() - cached.savedAt < 30 * 60_000) return cached.data;
  const delay = Math.max(0, 3000 - (Date.now() - lastOverpassAt));
  if (delay) await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
  lastOverpassAt = Date.now();
  const query = `[out:json][timeout:30];way["building"](around:${radius},${latitude},${longitude});out geom;`;
  const response = await fetch(overpassUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'RutoraUrbanTwin/1.0 (local student project)' },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) throw new Error(`OpenStreetMap building service returned ${response.status}.`);
  const payload = await response.json();
  const features = [];
  for (const way of (payload.elements || []).slice(0, 2500)) {
    if (!Array.isArray(way.geometry) || way.geometry.length < 3) continue;
    const ring = way.geometry.map(point => [Number(point.lon), Number(point.lat)]);
    if (ring.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) continue;
    const first = ring[0];
    const last = ring.at(-1);
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    if (ring.length < 4) continue;
    const tags = way.tags || {};
    const levels = Number.parseInt(tags['building:levels'] || '', 10) || null;
    const taggedHeight = osmHeightMeters(tags.height);
    const minHeight = osmHeightMeters(tags.min_height);
    features.push({
      type: 'Feature',
      properties: { osmId: Number(way.id), name: tags.name || null, building: tags.building || null, levels, height: taggedHeight || (levels ? levels * 3 : null), minHeight },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  const data = { type: 'FeatureCollection', features, truncated: (payload.elements || []).length > 2500 };
  buildingCache.set(key, { data, savedAt: Date.now() });
  return data;
}

function roadClass(tags) {
  return tags.highway || 'road';
}

async function buildModel(location, radiusMeters) {
  const latPad = radiusMeters / 111_320;
  const lonPad = radiusMeters / (111_320 * Math.max(.15, Math.cos(location.latitude * Math.PI / 180)));
  const south = location.latitude - latPad;
  const north = location.latitude + latPad;
  const west = location.longitude - lonPad;
  const east = location.longitude + lonPad;
  // Force old coordinate-only cached models to refresh once so the road graph
  // includes OSM node IDs and can distinguish real junctions from overpasses.
  const cacheBaseKey = `${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}:${radiusMeters}`;
  const key = `${cacheBaseKey}:topology-v4`;
  const existing = [...models.values()].find(m => m.cacheKey === key);
  if (existing) return existing;
  const cachedFallback = [...models.values()].find(m => m.cacheKey === cacheBaseKey || m.cacheKey?.startsWith(`${cacheBaseKey}:`));

  const delay = Math.max(0, 3000 - (Date.now() - lastOverpassAt));
  if (delay) await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
  lastOverpassAt = Date.now();
  const query = `[out:json][timeout:30];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${south},${west},${north},${east}););out geom;`;
  let response;
  try {
    response = await fetch(overpassUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'UrbanTwinPBLPrototype/1.0 (local student project)' },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    if (cachedFallback) {
      const cached = { ...cachedFallback, dataStatus: 'cached' };
      models.set(cached.id, cached);
      console.warn(`[api] Overpass unavailable; using cached OSM road snapshot for ${location.name}.`);
      return cached;
    }
    throw error;
  }
  if (!response.ok) {
    if (cachedFallback) {
      const cached = { ...cachedFallback, dataStatus: 'cached' };
      models.set(cached.id, cached);
      console.warn(`[api] Overpass returned ${response.status}; using cached OSM road snapshot for ${location.name}.`);
      return cached;
    }
    throw new Error(`Road data service returned ${response.status}. Try a smaller area or retry later.`);
  }
  const payload = await response.json();
  const roads = [];
  const nodeDegree = new Map();
  for (const way of payload.elements || []) {
    if (!way.geometry || way.geometry.length < 2) continue;
    const coordinates = way.geometry.map(point => [point.lat, point.lon]);
    const lengthMeters = coordinates.slice(1).reduce((sum, point, index) => sum + haversine(coordinates[index], point), 0);
    if (!lengthMeters) continue;
    const tags = way.tags || {};
    roads.push({
      id: String(way.id),
      name: tags.name || tags.ref || `${roadClass(tags)} road · ${lengthMeters} m`,
      highway: roadClass(tags),
      oneway: ['yes', '1', 'true'].includes(String(tags.oneway || '').toLowerCase()) || (!tags.oneway && tags.junction === 'roundabout'),
      reverseOneway: String(tags.oneway || '').toLowerCase() === '-1',
      lanes: Number.parseInt(tags.lanes || '1', 10) || 1,
      maxspeed: tags.maxspeed || null,
      access: tags.access || null,
      vehicleAccess: tags.vehicle || null,
      motorVehicleAccess: tags.motor_vehicle || null,
      motorcarAccess: tags.motorcar || null,
      hazardTags: roadHazards(tags),
      surface: tags.surface || null,
      smoothness: tags.smoothness || null,
      lengthMeters: Math.round(lengthMeters),
      coordinates,
      nodeIds: Array.isArray(way.nodes) && way.nodes.length === coordinates.length ? way.nodes.map(String) : null,
    });
    for (const endpoint of coordinates) {
      const node = `${endpoint[0].toFixed(5)},${endpoint[1].toFixed(5)}`;
      nodeDegree.set(node, (nodeDegree.get(node) || 0) + 1);
    }
  }
  if (!roads.length) throw new Error('No drivable roads found around that place. Increase the search radius and try again.');
  const networkKm = roads.reduce((sum, road) => sum + road.lengthMeters, 0) / 1000;
  const model = {
    id: randomUUID(),
    cacheKey: key,
    location,
    radiusMeters,
    roads,
    dataStatus: 'current',
    summary: {
      roadCount: roads.length,
      intersections: [...nodeDegree.values()].filter(degree => degree >= 3).length,
      networkKm: Number(networkKm.toFixed(1)),
    },
    createdAt: new Date().toISOString(),
  };
  models.set(model.id, model);
  await writeFile(cacheFile, JSON.stringify([...models.values()]), 'utf8');
  return model;
}

const trafficClassFactor = {
  motorway: 1.9, motorway_link: 1.25, trunk: 1.7, trunk_link: 1.2,
  primary: 1.45, primary_link: 1.1, secondary: 1.2, secondary_link: 1,
  tertiary: 1, tertiary_link: .9, unclassified: .85, residential: .8,
  living_street: .65, service: .55, road: .85,
};

const defaultRoadSpeedKph = {
  motorway: 100, motorway_link: 65, trunk: 80, trunk_link: 55,
  primary: 60, primary_link: 45, secondary: 50, secondary_link: 40,
  tertiary: 40, tertiary_link: 35, unclassified: 35, residential: 30,
  living_street: 15, service: 20, road: 30,
};

function roadHazards(tags) {
  const hazards = [];
  const yesValues = new Set(['yes', 'true', '1']);
  if (yesValues.has(String(tags.flood_prone || tags.flood_risk || '').toLowerCase())) hazards.push('Flood-prone road');
  if (yesValues.has(String(tags.landslide_prone || tags.landslide_risk || '').toLowerCase())) hazards.push('Landslide-prone road');
  if (yesValues.has(String(tags.avalanche_prone || '').toLowerCase())) hazards.push('Avalanche-prone road');
  if (yesValues.has(String(tags.ford || '').toLowerCase())) hazards.push('Ford crossing');
  const surface = String(tags.surface || '').toLowerCase();
  if (['unpaved', 'gravel', 'ground', 'dirt', 'mud', 'sand'].includes(surface)) hazards.push(`Unpaved surface (${surface})`);
  const smoothness = String(tags.smoothness || '').toLowerCase();
  if (['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable'].includes(smoothness)) hazards.push(`Poor surface (${smoothness.replace(/_/g, ' ')})`);
  return hazards;
}

function roadIsRestricted(road) {
  const access = road.motorcarAccess ?? road.motorVehicleAccess ?? road.vehicleAccess ?? road.access;
  return ['no', 'private', 'destination', 'delivery', 'customers', 'agricultural', 'forestry', 'permit'].includes(String(access || '').toLowerCase());
}

function roadSpeedKph(road) {
  const speed = String(road.maxspeed || '').match(/\d+(?:\.\d+)?/);
  if (speed) {
    const numeric = Number(speed[0]);
    const kph = /mph/i.test(road.maxspeed) ? numeric * 1.60934 : numeric;
    if (Number.isFinite(kph) && kph >= 5 && kph <= 160) return kph;
  }
  return defaultRoadSpeedKph[road.highway] || 30;
}

function roadCongestion(road, simulation) {
  return simulation.lastRoadTraffic?.[road.id]?.congestion || 'free';
}

function congestionSpeedFactor(congestion) {
  return congestion === 'heavy' ? .38 : congestion === 'slow' ? .68 : 1;
}

function hazardPenaltySeconds(road) {
  return (road.hazardTags || []).reduce((sum, hazard) => {
    if (/flood|landslide|avalanche/i.test(hazard)) return sum + 600;
    if (/ford|poor surface/i.test(hazard)) return sum + 240;
    return sum + 120;
  }, 0);
}

function roadScale(road) {
  const lanes = Math.max(1, Math.min(8, Number(road.lanes) || 1));
  const length = Math.max(.65, Math.min(2.2, Math.sqrt((Number(road.lengthMeters) || 250) / 250)));
  return (trafficClassFactor[road.highway] || .85) * Math.sqrt(lanes / 2) * length;
}

function hasCompleteNodeIds(roads) {
  return roads.length > 0 && roads.every(road => Array.isArray(road.coordinates) && Array.isArray(road.nodeIds) && road.nodeIds.length === road.coordinates.length);
}

function hasMappedAccessTags(roads) {
  const keys = ['access', 'vehicleAccess', 'motorVehicleAccess', 'motorcarAccess'];
  return roads.length > 0 && roads.every(road => keys.some(key => Object.hasOwn(road, key)));
}

function hasMappedHazardTags(roads) {
  return roads.length > 0 && roads.every(road => Array.isArray(road.hazardTags));
}

function roadNodeKey(point, nodeId, useNodeIds) {
  if (useNodeIds && nodeId != null) return `node:${nodeId}`;
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
}

function roadNodes(road, useNodeIds) {
  return (road.coordinates || []).map((point, index) => roadNodeKey(point, road.nodeIds?.[index], useNodeIds));
}

function roadsConnected(roads) {
  if (roads.length < 2) return roads.length === 1;
  const useNodeIds = hasCompleteNodeIds(roads);
  const roadsAtNode = new Map();
  for (const road of roads) {
    for (const key of new Set(roadNodes(road, useNodeIds))) {
      if (!roadsAtNode.has(key)) roadsAtNode.set(key, []);
      roadsAtNode.get(key).push(road.id);
    }
  }
  const visited = new Set([roads[0].id]);
  const queue = [roads[0].id];
  const byId = new Map(roads.map(road => [road.id, road]));
  for (let index = 0; index < queue.length; index += 1) {
    const road = byId.get(queue[index]);
    for (const key of new Set(roadNodes(road, useNodeIds))) {
      for (const neighborId of roadsAtNode.get(key) || []) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }
  }
  return visited.size === roads.length;
}

function pushDetourCandidate(heap, candidate) {
  let index = heap.length;
  heap.push(candidate);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].weight <= candidate.weight) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = candidate;
}

function popDetourCandidate(heap) {
  if (!heap.length) return null;
  const first = heap[0];
  const last = heap.pop();
  if (heap.length) {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= heap.length) break;
      const child = right < heap.length && heap[right].weight < heap[left].weight ? right : left;
      if (heap[child].weight >= last.weight) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return first;
}

function shortestDetourPath(graph, start, finish, bannedNodes = new Set(), bannedEdges = new Set()) {
  if (bannedNodes.has(start) || bannedNodes.has(finish)) return null;
  const queue = [];
  const distances = new Map([[start, 0]]);
  const previous = new Map();
  pushDetourCandidate(queue, { node: start, weight: 0 });
  while (queue.length) {
    const candidate = popDetourCandidate(queue);
    if (candidate.weight !== distances.get(candidate.node)) continue;
    if (candidate.node === finish) break;
    for (const edge of graph.get(candidate.node) || []) {
      if (bannedNodes.has(edge.to) || bannedEdges.has(edge.id)) continue;
      const weight = candidate.weight + edge.weight;
      if (weight >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, weight);
      previous.set(edge.to, { from: candidate.node, edge });
      pushDetourCandidate(queue, { node: edge.to, weight });
    }
  }
  if (!distances.has(finish)) return null;
  const edges = [];
  for (let node = finish; node !== start;) {
    const step = previous.get(node);
    if (!step) return null;
    edges.push(step.edge);
    node = step.from;
  }
  edges.reverse();
  return { edges, weight: distances.get(finish) };
}

function findDetours(model, targetRoad, blockedRoadIds, simulation) {
  const maxDetours = 5;
  if (!targetRoad?.coordinates || targetRoad.coordinates.length < 2) return [];
  const useNodeIds = hasCompleteNodeIds(model.roads);
  const accessTagsAvailable = hasMappedAccessTags(model.roads);
  const hazardTagsAvailable = hasMappedHazardTags(model.roads);
  const graph = new Map();
  let nextEdgeId = 0;
  const addEdge = (from, to, fromNodeId, toNodeId, roadId, weight) => {
    const fromKey = roadNodeKey(from, fromNodeId, useNodeIds);
    const toKey = roadNodeKey(to, toNodeId, useNodeIds);
    if (fromKey === toKey) return;
    if (!graph.has(fromKey)) graph.set(fromKey, []);
    const distanceMeters = haversine(from, to);
    graph.get(fromKey).push({ id: String(nextEdgeId++), from: fromKey, to: toKey, coordinates: [from, to], roadId, distanceMeters, weight: distanceMeters * weight });
  };
  for (const road of model.roads) {
    if (blockedRoadIds.has(road.id) || roadIsRestricted(road)) continue;
    const effectiveSpeedKph = roadSpeedKph(road) * congestionSpeedFactor(roadCongestion(road, simulation));
    const secondsPerMeter = 3600 / (Math.max(5, effectiveSpeedKph) * 1000);
    const hazardWeight = hazardPenaltySeconds(road) / Math.max(1, road.lengthMeters);
    const secondsPerMeterWithHazard = secondsPerMeter + hazardWeight;
    for (let index = 0; index < road.coordinates.length - 1; index++) {
      const from = road.coordinates[index];
      const to = road.coordinates[index + 1];
      const fromNodeId = road.nodeIds?.[index];
      const toNodeId = road.nodeIds?.[index + 1];
      if (road.reverseOneway) {
        addEdge(to, from, toNodeId, fromNodeId, road.id, secondsPerMeterWithHazard);
      } else {
        addEdge(from, to, fromNodeId, toNodeId, road.id, secondsPerMeterWithHazard);
        if (!road.oneway) addEdge(to, from, toNodeId, fromNodeId, road.id, secondsPerMeterWithHazard);
      }
    }
  }
  // OSM ways can terminate at a dead end even when their middle nodes connect
  // to a usable street grid. Searching only from the way's literal first and
  // last nodes incorrectly reports "no bypass" for those roads. Route from
  // the furthest connected junctions along the closed way instead.
  const routeIndexes = Array.from({ length: targetRoad.coordinates.length }, (_, index) => index);
  if (targetRoad.reverseOneway) routeIndexes.reverse();
  const incomingNodes = new Set([...graph.values()].flatMap(edges => edges.map(edge => edge.to)));
  let accessIndexes = routeIndexes.filter(index => {
    const node = roadNodeKey(targetRoad.coordinates[index], targetRoad.nodeIds?.[index], useNodeIds);
    return (graph.get(node)?.length ?? 0) > 0 || incomingNodes.has(node);
  });
  if (accessIndexes.length > 32) {
    accessIndexes = Array.from({ length: 32 }, (_, index) => accessIndexes[Math.round(index * (accessIndexes.length - 1) / 31)]);
  }
  const endpointPairs = [];
  for (let startOrder = 0; startOrder < accessIndexes.length; startOrder += 1) {
    const startIndex = accessIndexes[startOrder];
    const start = roadNodeKey(targetRoad.coordinates[startIndex], targetRoad.nodeIds?.[startIndex], useNodeIds);
    if (!(graph.get(start)?.length ?? 0)) continue;
    for (let endOrder = startOrder + 1; endOrder < accessIndexes.length; endOrder += 1) {
      const endIndex = accessIndexes[endOrder];
      const finish = roadNodeKey(targetRoad.coordinates[endIndex], targetRoad.nodeIds?.[endIndex], useNodeIds);
      if (!incomingNodes.has(finish)) continue;
      endpointPairs.push({ startIndex, endIndex, start, finish, span: endOrder - startOrder });
    }
  }
  endpointPairs.sort((first, second) => second.span - first.span);
  const endpoints = endpointPairs.slice(0, 64).find(pair => pair.start !== pair.finish && shortestDetourPath(graph, pair.start, pair.finish)?.edges.length);
  if (!endpoints) return [];
  const { start, finish, startIndex: routeStartIndex, endIndex: routeEndIndex } = endpoints;
  const firstPath = shortestDetourPath(graph, start, finish);
  if (!firstPath?.edges.length) return [];
  const paths = [firstPath];
  const candidates = [];
  const knownSignatures = new Set();
  const signatureOf = edges => edges.map(edge => `${edge.from}>${edge.to}:${edge.roadId}`).join('|');
  knownSignatures.add(signatureOf(firstPath.edges));

  for (let pathIndex = 1; pathIndex < maxDetours; pathIndex += 1) {
    const previousPath = paths[pathIndex - 1];
    for (let spurIndex = 0; spurIndex < previousPath.edges.length; spurIndex += 1) {
      const rootEdges = previousPath.edges.slice(0, spurIndex);
      const rootNodes = [start, ...rootEdges.map(edge => edge.to)];
      const spurNode = rootNodes.at(-1);
      const bannedNodes = new Set(rootNodes.slice(0, -1));
      const bannedEdges = new Set();
      for (const path of paths) {
        if (path.edges.length <= spurIndex || !rootEdges.every((edge, index) => path.edges[index]?.id === edge.id)) continue;
        bannedEdges.add(path.edges[spurIndex].id);
      }
      const spurPath = shortestDetourPath(graph, spurNode, finish, bannedNodes, bannedEdges);
      if (!spurPath) continue;
      const edges = [...rootEdges, ...spurPath.edges];
      const signature = signatureOf(edges);
      if (knownSignatures.has(signature)) continue;
      knownSignatures.add(signature);
      const weight = edges.reduce((sum, edge) => sum + edge.weight, 0);
      pushDetourCandidate(candidates, { edges, weight });
    }
    const nextPath = popDetourCandidate(candidates);
    if (!nextPath) break;
    paths.push(nextPath);
  }

  const roadById = new Map(model.roads.map(road => [road.id, road]));
  const alternatives = paths.map(path => {
    const roadIds = [...new Set(path.edges.map(edge => edge.roadId))];
    const roadDistances = new Map();
    for (const edge of path.edges) roadDistances.set(edge.roadId, (roadDistances.get(edge.roadId) || 0) + edge.distanceMeters);
    let estimatedSeconds = 0;
    let estimatedFreeflowSeconds = 0;
    let hazardPenaltySecondsTotal = 0;
    let slowDistance = 0;
    let heavyDistance = 0;
    const hazards = [];
    for (const [roadId, distanceMeters] of roadDistances) {
      const road = roadById.get(roadId);
      if (!road) continue;
      const freeSpeed = roadSpeedKph(road);
      const congestion = roadCongestion(road, simulation);
      const measuredSpeed = Number(simulation.lastRoadTraffic?.[road.id]?.averageSpeedKph);
      const actualSpeed = Number.isFinite(measuredSpeed) && measuredSpeed > 2
        ? Math.min(freeSpeed, measuredSpeed)
        : freeSpeed * congestionSpeedFactor(congestion);
      estimatedFreeflowSeconds += distanceMeters / 1000 / freeSpeed * 3600;
      estimatedSeconds += distanceMeters / 1000 / Math.max(5, actualSpeed) * 3600;
      if (congestion === 'heavy') heavyDistance += distanceMeters;
      else if (congestion === 'slow') slowDistance += distanceMeters;
      const penalty = hazardPenaltySeconds(road) * Math.min(1, distanceMeters / Math.max(1, road.lengthMeters));
      hazardPenaltySecondsTotal += penalty;
      for (const hazard of road.hazardTags || []) if (!hazards.includes(hazard)) hazards.push(hazard);
    }
    const distanceMeters = Math.round(path.edges.reduce((sum, edge) => sum + edge.distanceMeters, 0));
    const congestion = heavyDistance / Math.max(1, distanceMeters) >= .25 ? 'heavy' : slowDistance / Math.max(1, distanceMeters) >= .25 ? 'slow' : 'free';
    const congestionDelaySeconds = Math.max(0, Math.round(estimatedSeconds - estimatedFreeflowSeconds));
    return {
      coordinates: [targetRoad.coordinates[routeStartIndex], ...path.edges.map(edge => edge.coordinates[1])],
      roadIds,
      distanceMeters,
      estimatedSeconds: Math.round(estimatedSeconds),
      congestionDelaySeconds,
      congestion,
      hazardPenaltySeconds: Math.round(hazardPenaltySecondsTotal),
      hazards,
      usefulnessScore: Math.round(estimatedSeconds + hazardPenaltySecondsTotal),
      restrictionsApplied: accessTagsAvailable,
      hazardDataAvailable: hazardTagsAvailable,
    };
  }).filter(detour => detour.coordinates.length >= 2 && detour.roadIds.length > 0);
  alternatives.sort((first, second) => first.usefulnessScore - second.usefulnessScore || first.estimatedSeconds - second.estimatedSeconds || first.distanceMeters - second.distanceMeters);
  const fastest = Math.min(...alternatives.map(detour => detour.estimatedSeconds));
  const leastCongested = Math.min(...alternatives.map(detour => detour.congestionDelaySeconds));
  const lowestHazardPenalty = Math.min(...alternatives.map(detour => detour.hazardPenaltySeconds));
  const fastestIndex = alternatives.findIndex(detour => detour.estimatedSeconds === fastest);
  const leastCongestedIndex = alternatives.findIndex(detour => detour.congestionDelaySeconds === leastCongested);
  const lowestHazardIndex = hazardTagsAvailable && lowestHazardPenalty > 0 ? alternatives.findIndex(detour => detour.hazardPenaltySeconds === lowestHazardPenalty) : -1;
  const distanceRanks = new Map([...alternatives].sort((first, second) => first.distanceMeters - second.distanceMeters).map((detour, index) => [detour, index + 1]));
  return alternatives.map((detour, index) => ({ ...detour, distanceRank: distanceRanks.get(detour), badges: [
    ...(index === fastestIndex ? ['Fastest modeled ETA'] : []),
    ...(index === leastCongestedIndex && leastCongested > 0 ? ['Least modeled congestion delay'] : []),
    ...(index === lowestHazardIndex ? ['Lowest OSM hazard weight'] : []),
  ] }));
}

function hasMappedDetour(closure) {
  return closure.detours?.some(detour => detour.coordinates?.length >= 2 && detour.roadIds?.length > 0) ?? false;
}

function refreshClosureDetours(simulation, model) {
  const blockedRoadIds = new Set(simulation.closures.map(closure => closure.roadId));
  for (const closure of simulation.closures) {
    const road = model.roads.find(item => item.id === closure.roadId);
    if (!road) continue;
    closure.detours = findDetours(model, road, blockedRoadIds, simulation);
  }
}

function expireClosures(simulation) {
  const now = Date.now();
  const expired = simulation.closures.filter(closure => closure.expiresAt <= now);
  if (!expired.length) return;
  const expiredIds = new Set(expired.map(closure => closure.id));
  simulation.closures = simulation.closures.filter(closure => !expiredIds.has(closure.id));
  for (const closure of expired) {
    simulation.recentlyReopened[closure.roadId] = simulation.step + 3;
    simulation.events.push({ id: randomUUID(), kind: 'reopened', roadId: closure.roadId, roadName: closure.roadName, reason: closure.reason, message: `${closure.roadName} is ready to use again. Traffic is returning to the live road network.` });
  }
  const model = models.get(simulation.modelId);
  if (model && simulation.closures.length) refreshClosureDetours(simulation, model);
  void commandSumoSimulation(simulation.id, 'close-roads', { roadIds: simulation.closures.map(closure => closure.roadId) })
    .then(snapshot => { simulation.sumoSnapshot = snapshot; })
    .catch(error => console.error(`[sumo] Could not apply automatic road reopening: ${error.message}`));
}

setInterval(() => {
  for (const simulation of simulations.values()) expireClosures(simulation);
}, 500).unref();

function routeLengthMeters(coordinates) {
  return coordinates.slice(1).reduce((sum, point, index) => sum + haversine(coordinates[index], point), 0);
}

function formatClosureDuration(minutes) {
  if (minutes % (365 * 24 * 60) === 0) {
    const years = minutes / (365 * 24 * 60);
    return `${years} year${years === 1 ? '' : 's'}`;
  }
  if (minutes % (30 * 24 * 60) === 0) {
    const months = minutes / (30 * 24 * 60);
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return `${weeks} week${weeks === 1 ? '' : 's'}`;
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes.toLocaleString()} minute${minutes === 1 ? '' : 's'}`;
}

function pointAlongCoordinates(coordinates, progress) {
  if (!coordinates?.length) return [0, 0];
  if (coordinates.length === 1) return coordinates[0];
  const target = Math.max(0, Math.min(.99999, progress)) * routeLengthMeters(coordinates);
  let travelled = 0;
  for (let index = 0; index < coordinates.length - 1; index++) {
    const distance = haversine(coordinates[index], coordinates[index + 1]);
    if (travelled + distance >= target) {
      const part = distance ? (target - travelled) / distance : 0;
      return [coordinates[index][0] + (coordinates[index + 1][0] - coordinates[index][0]) * part, coordinates[index][1] + (coordinates[index + 1][1] - coordinates[index][1]) * part];
    }
    travelled += distance;
  }
  return coordinates.at(-1);
}

function simulationSnapshot(simulation) {
  expireClosures(simulation);
  const model = models.get(simulation.modelId);
  const trafficSignature = Object.entries(simulation.lastRoadTraffic || {}).map(([roadId, traffic]) => roadId + ':' + traffic.congestion).join('|');
  if (simulation.closures.length && simulation.detourTrafficSignature !== trafficSignature) {
    refreshClosureDetours(simulation, model);
    simulation.detourTrafficSignature = trafficSignature;
  }
  const roads = model.roads;
  const raw = simulation.sumoSnapshot || {};
  const roadCounts = raw.roadCounts || {};
  const closureByRoadId = new Map(simulation.closures.map(closure => [closure.roadId, closure]));
  const manualCounts = new Map();
  const manualRoadIds = simulation.manualTrafficControl?.roadIds || [];
  const manualTotal = Math.max(0, Math.round(simulation.manualTrafficControl?.vehicles || 0));
  manualRoadIds.forEach((roadId, index) => {
    const base = Math.floor(manualTotal / manualRoadIds.length);
    manualCounts.set(roadId, base + (index < manualTotal % manualRoadIds.length ? 1 : 0));
  });
  const rangeMin = simulation.averageVehiclesPerRoadMin ?? 0;
  const rangeMax = simulation.averageVehiclesPerRoadMax ?? 0;
  const rangeSpan = Math.max(0, rangeMax - rangeMin + 1);
  const rangeVehicleCount = roadId => {
    if (!simulation.averageVehiclesPerRoadEnabled || !rangeSpan) return null;
    let hash = 2166136261;
    for (const character of String(roadId)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return rangeMin + ((hash >>> 0) % rangeSpan);
  };
  const roadTraffic = Object.fromEntries(roads.map(road => {
    const scale = roadScale(road);
    const slowThreshold = Math.max(2, Math.round(simulation.slowThresholdVehicles * scale));
    const heavyThreshold = Math.max(slowThreshold + 1, Math.round(simulation.heavyThresholdVehicles * scale));
    const sumoVehicles = Number(roadCounts[road.id]) || 0;
    const rangeCount = rangeVehicleCount(road.id);
    const count = manualCounts.has(road.id) ? manualCounts.get(road.id) : rangeCount ?? sumoVehicles;
    const congestion = closureByRoadId.has(road.id) ? 'closed' : simulation.recentlyReopened[road.id] >= (raw.simulatedSeconds || 0) ? 'free' : count >= heavyThreshold ? 'heavy' : count >= slowThreshold ? 'slow' : 'free';
    const measuredSpeed = Number(raw.roadMeanSpeedKph?.[road.id]);
    const source = manualCounts.has(road.id) ? 'route-target' : rangeCount !== null ? 'network-range' : 'sumo';
    return [road.id, { vehicles: count, sumoVehicles, slowThreshold, heavyThreshold, congestion, source, ...(Number.isFinite(measuredSpeed) ? { averageSpeedKph: Math.round(measuredSpeed) } : {}), manual: source !== 'sumo' }];
  }));
  const levels = Object.values(roadTraffic);
  const congestionIndex = Math.round(100 * levels.reduce((sum, road) => sum + Math.min(1, road.vehicles / road.heavyThreshold), 0) / Math.max(1, levels.length));
  simulation.lastRoadTraffic = roadTraffic;
  simulation.step = Math.floor(raw.simulatedSeconds || 0);
  const closureDetourRoadIds = new Map();
  for (const closure of simulation.closures) {
    closure.detours.forEach((detour, index) => {
      for (const roadId of detour.roadIds) if (!closureDetourRoadIds.has(roadId)) closureDetourRoadIds.set(roadId, index);
    });
  }
  const vehicles = (raw.vehicles || []).map(vehicle => {
    const detourIndex = closureDetourRoadIds.get(vehicle.roadId);
    return { ...vehicle, detouring: detourIndex !== undefined, detourIndex, closureId: null };
  });
  return {
    id: simulation.id,
    status: simulation.status,
    step: simulation.step,
    speed: simulation.speed,
    elapsedMinutes: Math.floor((raw.simulatedSeconds || 0) / 60),
    vehicles,
    roadTraffic,
    closures: simulation.closures.map(closure => ({ ...closure, remainingMs: Math.max(0, closure.expiresAt - Date.now()) })),
    events: simulation.events.splice(0),
    settings: {
      trafficVolume: simulation.trafficVolume,
      slowThresholdVehicles: simulation.slowThresholdVehicles,
      heavyThresholdVehicles: simulation.heavyThresholdVehicles,
      averageVehiclesPerRoadEnabled: simulation.averageVehiclesPerRoadEnabled,
      averageVehiclesPerRoadMin: simulation.averageVehiclesPerRoadMin,
      averageVehiclesPerRoadMax: simulation.averageVehiclesPerRoadMax,
    },
    manualTrafficControl: simulation.manualTrafficControl || null,
    engine: { name: 'SUMO', version: sumoStatus().version || 'installed', mode: 'microsimulation', demandVehiclesPerHour: simulation.trafficVolume, departed: raw.departed || 0, arrived: raw.arrived || 0, collisions: raw.collisions || 0 },
    metrics: { congestionIndex, averageSpeedKph: Math.round(raw.averageSpeedKph || 0), activeVehicles: Math.max(0, Math.round(raw.activeVehicles || 0)) },
  };
}

function validCoordinate(value, max) {
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && Math.abs(coordinate) <= max ? coordinate : null;
}

function maneuverText(step) {
  const type = step.maneuver?.type || 'continue';
  const modifier = step.maneuver?.modifier;
  const road = step.name ? ` onto ${step.name}` : '';
  if (type === 'depart') return `Head ${modifier || 'straight'}${road}`;
  if (type === 'arrive') return 'Arrive at your destination';
  if (type === 'roundabout' || type === 'rotary') return `Enter the roundabout${step.maneuver?.exit ? ` and take exit ${step.maneuver.exit}` : ''}${road}`;
  if (type === 'turn' || type === 'end of road' || type === 'fork' || type === 'merge' || type === 'on ramp' || type === 'off ramp') {
    const action = type === 'turn' ? 'Turn' : type === 'end of road' ? 'At the end of the road, turn' : type === 'fork' ? 'Keep' : type === 'merge' ? 'Merge' : type === 'on ramp' ? 'Take the ramp' : type === 'off ramp' ? 'Take the exit' : 'Continue';
    return `${action}${modifier ? ` ${modifier}` : ''}${road}`;
  }
  return `${type === 'new name' ? 'Continue' : type[0].toUpperCase() + type.slice(1)}${road}`;
}

async function getRoute(startLat, startLon, endLat, endLon) {
  const routeUrl = `${routingUrl}/route/v1/driving/${startLon},${startLat};${endLon},${endLat}`;
  const requestUrl = new URL(routeUrl);
  requestUrl.searchParams.set('steps', 'true');
  requestUrl.searchParams.set('alternatives', 'true');
  requestUrl.searchParams.set('geometries', 'geojson');
  requestUrl.searchParams.set('overview', 'full');
  const response = await fetch(requestUrl, { signal: AbortSignal.timeout(20_000) });
  const payload = await response.json();
  if (!response.ok || payload.code !== 'Ok' || !payload.routes?.length) {
    const detail = payload.message || payload.code || `HTTP ${response.status}`;
    throw new Error(`No drivable route was returned (${detail}). Check the points or try another routing endpoint.`);
  }
  return payload.routes.map(route => ({
    distanceMeters: Math.round(route.distance),
    durationSeconds: Math.round(route.duration),
    coordinates: route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]),
    steps: (route.legs || []).flatMap(leg => leg.steps || []).map(step => ({
      instruction: maneuverText(step),
      road: step.name || '',
      distanceMeters: Math.round(step.distance || 0),
      durationSeconds: Math.round(step.duration || 0),
      location: step.maneuver?.location ? [step.maneuver.location[1], step.maneuver.location[0]] : null,
    })),
  }));
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  try {
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok', service: 'urban-twin-api', version: 13, engine: sumoStatus(), features: ['road-thresholds-v1', 'manual-road-demand-v1', 'immediate-manual-road-thresholds-v1', 'network-average-vehicle-range-v1', 'gps-routing-v1', 'timed-road-closures-v2', 'closure-countdown-units-v1', 'live-diversion-v1', 'topology-aware-road-detours-v4', 'connected-junction-detours-v1', 'labeled-detour-routes-v1', 'multiple-road-detours-v1', 'road-closure-event-name-fix-v1', 'usefulness-ranked-detours-v1', 'sumo-micro-simulation-v1', 'open-meteo-current-weather-v2', 'weather-valid-time-wind-direction-v1'], modelsCached: models.size });
    if (req.method === 'GET' && url.pathname === '/api/weather') {
      const latitude = validCoordinate(url.searchParams.get('latitude'), 90);
      const longitude = validCoordinate(url.searchParams.get('longitude'), 180);
      if (latitude === null || longitude === null) return send(res, 400, { error: 'Provide valid location coordinates for weather.' });
      return send(res, 200, await getWeather(latitude, longitude));
    }
    if (req.method === 'GET' && url.pathname === '/api/buildings') {
      const latitude = validCoordinate(url.searchParams.get('latitude'), 90);
      const longitude = validCoordinate(url.searchParams.get('longitude'), 180);
      if (latitude === null || longitude === null) return send(res, 400, { error: 'Provide valid coordinates for building footprints.' });
      const radiusMeters = Math.max(400, Math.min(1500, Number(url.searchParams.get('radiusMeters')) || 800));
      return send(res, 200, await getBuildings(latitude, longitude, radiusMeters));
    }
    if (req.method === 'GET' && url.pathname === '/api/geocode') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2 || q.length > 120) return send(res, 400, { error: 'Enter a place name between 2 and 120 characters.' });
      return send(res, 200, { results: await geocode(q) });
    }
    if (req.method === 'GET' && url.pathname === '/api/route') {
      const startLat = validCoordinate(url.searchParams.get('startLat'), 90);
      const startLon = validCoordinate(url.searchParams.get('startLon'), 180);
      const endLat = validCoordinate(url.searchParams.get('endLat'), 90);
      const endLon = validCoordinate(url.searchParams.get('endLon'), 180);
      if ([startLat, startLon, endLat, endLon].some(value => value === null)) return send(res, 400, { error: 'Provide valid start and destination coordinates.' });
      return send(res, 200, { routes: await getRoute(startLat, startLon, endLat, endLon), provider: 'OSRM / OpenStreetMap' });
    }
    if (req.method === 'POST' && url.pathname === '/api/models') {
      const body = await readBody(req);
      const latitude = Number(body.location?.latitude);
      const longitude = Number(body.location?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return send(res, 400, { error: 'Choose a valid search result first.' });
      const radius = Math.max(400, Math.min(1500, Number(body.radiusMeters) || 800));
      const model = await buildModel({ ...body.location, latitude, longitude }, radius);
      return send(res, 201, model);
    }
    if (req.method === 'POST' && url.pathname === '/api/simulations') {
      const body = await readBody(req);
      if (!models.has(body.modelId)) return send(res, 404, { error: 'Build a location road model before starting a simulation.' });
      const simulation = { id: randomUUID(), modelId: body.modelId, status: 'paused', speed: 1, step: 0, trafficVolume: Math.round(Number(body.trafficVolume) || 320), slowThresholdVehicles: 8, heavyThresholdVehicles: 16, averageVehiclesPerRoadEnabled: false, averageVehiclesPerRoadMin: 0, averageVehiclesPerRoadMax: 20, manualTrafficControl: null, closures: [], events: [], recentlyReopened: {}, rainMmH: Math.max(0, Math.min(200, Number(body.rainMmH) || 0)), lastRoadTraffic: {} };
      simulation.sumoSnapshot = await startSumoSimulation({ id: simulation.id, model: models.get(body.modelId), trafficVolume: simulation.trafficVolume, rainMmH: simulation.rainMmH });
      simulations.set(simulation.id, simulation);
      return send(res, 201, simulationSnapshot(simulation));
    }
    const simulationMatch = url.pathname.match(/^\/api\/simulations\/([^/]+)(?:\/(tick|command))?$/);
    if (simulationMatch) {
      const simulation = simulations.get(simulationMatch[1]);
      if (!simulation) return send(res, 404, { error: 'Simulation not found. Build the location model again.' });
      if (req.method === 'PATCH' && simulationMatch[2] === 'command') {
        const body = await readBody(req);
        if (body.action === 'play') simulation.status = 'playing';
        else if (body.action === 'pause') simulation.status = 'paused';
        else if (body.action === 'reset') {
          simulation.status = 'paused'; simulation.step = 0; simulation.closures = []; simulation.recentlyReopened = {};
          simulation.manualTrafficControl = null;
          simulation.sumoSnapshot = await commandSumoSimulation(simulation.id, 'reset', { rainMmH: simulation.rainMmH });
        }
        else if (body.action === 'speed') simulation.speed = [1, 2, 4].includes(Number(body.value)) ? Number(body.value) : 1;
        else if (body.action === 'close-road') {
          const model = models.get(simulation.modelId);
          const roadId = String(body.value?.roadId || '');
          const road = model.roads.find(item => item.id === roadId);
          const durationMinutes = Number(body.value?.durationMinutes);
          const reason = String(body.value?.reason || '').trim();
          if (!road) return send(res, 404, { error: 'Choose a road from the active road model.' });
          if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_CLOSURE_DURATION_MINUTES) return send(res, 400, { error: 'Enter a whole closure duration from 1 minute to 1 year (525,600 minutes).' });
          if (reason.length < 3 || reason.length > 180) return send(res, 400, { error: 'Enter a closure reason from 3 to 180 characters.' });
          if (simulation.closures.some(closure => closure.roadId === roadId)) return send(res, 409, { error: 'This road is already closed in the current simulation.' });
          const manualRouteAffected = simulation.manualTrafficControl?.roadIds.includes(roadId) ?? false;
          if (manualRouteAffected) {
            simulation.manualTrafficControl = null;
            await commandSumoSimulation(simulation.id, 'manual-route', { roadIds: [], vehicles: 0 });
          }
          const closure = { id: randomUUID(), roadId, roadName: road.name, reason, durationMinutes, startedAt: Date.now(), expiresAt: Date.now() + durationMinutes * 60_000, detours: [] };
          simulation.closures.push(closure);
          refreshClosureDetours(simulation, model);
          simulation.sumoSnapshot = await commandSumoSimulation(simulation.id, 'close-roads', { roadIds: simulation.closures.map(item => item.roadId) });
          const hasDetour = hasMappedDetour(closure);
          const diversionMessage = hasDetour
            ? closure.detours.length === 1
              ? 'One mapped alternate route is available; its estimate uses modeled traffic and mapped road conditions.'
              : `${closure.detours.length} mapped alternate routes are available. Their colors rank them by estimated time, modeled congestion, and mapped hazard exposure.`
            : 'No connected alternate road was found in this map area; vehicles are held at the closure.';
          simulation.events.push({ id: randomUUID(), kind: 'closed', roadId, roadName: road.name, reason, message: `${road.name} is closed for ${formatClosureDuration(durationMinutes)}: ${reason}. ${diversionMessage}${manualRouteAffected ? ' Manual route traffic control was cleared.' : ''}` });
        }
        else if (body.action === 'open-road') {
          const roadId = String(body.value?.roadId || '');
          const closure = simulation.closures.find(item => item.roadId === roadId);
          if (!closure) return send(res, 404, { error: 'This road is not currently closed.' });
          simulation.closures = simulation.closures.filter(item => item.roadId !== roadId);
          simulation.recentlyReopened[roadId] = simulation.step + 3;
          simulation.sumoSnapshot = await commandSumoSimulation(simulation.id, 'close-roads', { roadIds: simulation.closures.map(item => item.roadId) });
          simulation.events.push({ id: randomUUID(), kind: 'reopened', roadId, roadName: closure.roadName, reason: closure.reason, message: `${closure.roadName} is ready to use again. Traffic is returning to the live road network.` });
          const model = models.get(simulation.modelId);
          if (simulation.closures.length) refreshClosureDetours(simulation, model);
        }
        else if (body.action === 'configure') {
          const trafficVolume = Math.round(Number(body.value?.trafficVolume));
          const slow = Math.round(Number(body.value?.slowThresholdVehicles));
          const heavy = Math.round(Number(body.value?.heavyThresholdVehicles));
          const rangeMin = Math.round(Number(body.value?.averageVehiclesPerRoadMin ?? simulation.averageVehiclesPerRoadMin));
          const rangeMax = Math.round(Number(body.value?.averageVehiclesPerRoadMax ?? simulation.averageVehiclesPerRoadMax));
          const rangeEnabled = body.value?.averageVehiclesPerRoadEnabled === undefined ? simulation.averageVehiclesPerRoadEnabled : Boolean(body.value.averageVehiclesPerRoadEnabled);
          if (!Number.isFinite(trafficVolume) || trafficVolume < 10 || trafficVolume > 3000 || !Number.isFinite(slow) || slow < 1 || slow > 500 || !Number.isFinite(heavy) || heavy <= slow || heavy > 1000) return send(res, 400, { error: 'Use 10–3000 vehicles, a slow threshold from 1–500, and a red threshold above slow up to 1000.' });
          if (!Number.isInteger(rangeMin) || !Number.isInteger(rangeMax) || rangeMin < 0 || rangeMax < rangeMin || rangeMax > 1000) return send(res, 400, { error: 'Set a whole-number average vehicle range from 0 to 1,000 per road, with the maximum at least the minimum.' });
          simulation.trafficVolume = trafficVolume;
          simulation.slowThresholdVehicles = slow;
          simulation.heavyThresholdVehicles = heavy;
          simulation.averageVehiclesPerRoadEnabled = rangeEnabled;
          simulation.averageVehiclesPerRoadMin = rangeMin;
          simulation.averageVehiclesPerRoadMax = rangeMax;
          simulation.sumoSnapshot = await commandSumoSimulation(simulation.id, 'configure', { trafficVolume });
        }
        else if (body.action === 'set-road-traffic') {
          const model = models.get(simulation.modelId);
          const roadIds = body.value?.roadIds;
          const vehicles = Number(body.value?.vehicles);
          if (!Array.isArray(roadIds) || roadIds.length < 1 || roadIds.length > 100 || roadIds.some(id => typeof id !== 'string')) return send(res, 400, { error: 'Select between 1 and 100 roads for manual traffic control.' });
          if (!Number.isInteger(vehicles) || vehicles < 0 || vehicles > 3000) return send(res, 400, { error: 'Enter a whole vehicle target from 0 to 3,000.' });
          const uniqueIds = [...new Set(roadIds)];
          if (uniqueIds.length !== roadIds.length) return send(res, 400, { error: 'Each road can only appear once in the selected route.' });
          const selectedRoads = uniqueIds.map(roadId => model.roads.find(road => road.id === roadId));
          if (selectedRoads.some(road => !road)) return send(res, 404, { error: 'Every selected road must belong to the active road model.' });
          if (selectedRoads.some(road => simulation.closures.some(closure => closure.roadId === road.id))) return send(res, 409, { error: 'Reopen closed roads before applying a manual traffic count.' });
          if (!roadsConnected(selectedRoads)) return send(res, 400, { error: 'Selected roads must form one connected route.' });
          simulation.sumoSnapshot = await commandSumoSimulation(simulation.id, 'manual-route', { roadIds: uniqueIds, vehicles });
          simulation.manualTrafficControl = { roadIds: uniqueIds, vehicles };
        }
        else if (body.action === 'clear-road-traffic') {
          simulation.manualTrafficControl = null;
          simulation.sumoSnapshot = await commandSumoSimulation(simulation.id, 'manual-route', { roadIds: [], vehicles: 0 });
        }
        else return send(res, 400, { error: 'Use play, pause, reset, speed, close-road, open-road, configure, set-road-traffic, or clear-road-traffic.' });
        return send(res, 200, simulationSnapshot(simulation));
      }
      if (req.method === 'GET' && simulationMatch[2] === 'tick') {
        if (simulation.status === 'playing') {
          simulation.sumoSnapshot = await commandSumoSimulation(simulation.id, 'step', { steps: simulation.speed });
          simulation.step = Math.floor(simulation.sumoSnapshot.simulatedSeconds || 0);
        }
        return send(res, 200, simulationSnapshot(simulation));
      }
      if (req.method === 'GET' && !simulationMatch[2]) return send(res, 200, simulationSnapshot(simulation));
    }
    return send(res, 404, { error: 'Route not found.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    const status = /timed out|fetch failed|SUMO|TraCI/i.test(message) ? 503 : 500;
    console.error(`[api] ${req.method} ${url.pathname}: ${message}`);
    return send(res, status, { error: message });
  }
});

server.listen(port, host, () => console.log(`Rutora API listening at http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await stopAllSumoSimulations(); process.exit(0); }));
