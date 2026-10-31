import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowRight, BarChart3, Bell,
  Building2, Check, ChevronDown, ChevronRight, Clock3, CloudRain, Compass, Crosshair,
  ExternalLink, Gauge, Layers3, Map as MapIcon, MapPin, Maximize2, Menu, Minimize2, Minus, Monitor, Moon, PartyPopper, Pause, Play,
  LocateFixed, Navigation, Plus, Radio, RotateCcw, Route, Satellite, Search, Settings2, ShieldAlert, SlidersHorizontal,
  Sparkles, Sun, TrafficCone, TrendingUp, X, Zap, ChevronUp,
} from 'lucide-react';
import { divIcon } from 'leaflet';
import { Circle, CircleMarker, GeoJSON, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { incidents, sources, type Incident } from './data';

const apiBaseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const apiFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === 'string' && input.startsWith('/api/') ? `${apiBaseUrl}${input}` : input;
  return fetch(target, init);
};

type LayerKey = 'Traffic' | 'Incidents' | 'Disaster' | 'Infrastructure';
const initialLayers: Record<LayerKey, boolean> = { Traffic: true, Incidents: true, Disaster: false, Infrastructure: true };
const detourPalette = ['#8B5CF6', '#0EA5E9', '#F97316', '#E11D48', '#14B8A6'];
const satelliteTileUrl = import.meta.env.VITE_SATELLITE_TILE_URL || 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const satelliteAttribution = import.meta.env.VITE_SATELLITE_ATTRIBUTION || '&copy; <a href="https://goto.arcgisonline.com/maps/World_Imagery">Esri World Imagery</a>, Vantor, Earthstar Geographics, and the GIS User Community';
const satelliteMaxZoom = 19;
type WorkspacePanel = 'operations' | 'incidents' | 'predictions' | 'settings';
type Appearance = 'dark' | 'light' | 'system';
type FontFamily = 'dm-sans' | 'atkinson' | 'system' | 'inter' | 'roboto' | 'open-sans' | 'lato' | 'montserrat' | 'poppins' | 'nunito-sans' | 'source-sans' | 'ibm-plex-sans' | 'roboto-condensed' | 'work-sans' | 'plus-jakarta' | 'space-grotesk' | 'fira-sans' | 'ubuntu' | 'roboto-slab' | 'merriweather' | 'lora' | 'space-mono' | 'jetbrains-mono';
type FontScale = 'low' | 'medium' | 'high';
type ClosureDurationUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';
const closureDurationUnits: { id: ClosureDurationUnit; short: string; label: string; minutes: number; max: number }[] = [
  { id: 'minutes', short: 'MIN', label: 'Minutes', minutes: 1, max: 525_600 },
  { id: 'hours', short: 'HRS', label: 'Hours', minutes: 60, max: 8_760 },
  { id: 'days', short: 'DAYS', label: 'Days', minutes: 1_440, max: 365 },
  { id: 'weeks', short: 'WKS', label: 'Weeks', minutes: 10_080, max: 52 },
  { id: 'months', short: 'MOS', label: 'Months', minutes: 43_200, max: 12 },
  { id: 'years', short: 'YRS', label: 'Years', minutes: 525_600, max: 1 },
];
type LocationResult = { id: number; name: string; latitude: number; longitude: number; country: string; admin1?: string; feature_code?: string };
type WeatherReport = { current: Record<string, number | string>; current_units: Record<string, string>; timezone: string; fetchedAt: string; provider: string; latitude: number; longitude: number };
type ApiHealth = { status: string; engine?: { available: boolean; engine: string; version?: string; reason?: string } };
type RoadModel = { id: string; name: string; highway: string; oneway: boolean; lanes: number; lengthMeters: number; coordinates: [number, number][] };
type ModelData = { id: string; location: LocationResult; radiusMeters: number; dataStatus?: 'current' | 'cached'; createdAt?: string; roads: RoadModel[]; summary: { roadCount: number; intersections: number; networkKm: number } };
type RoadTraffic = { vehicles: number; sumoVehicles?: number; slowThreshold: number; heavyThreshold: number; congestion: 'free' | 'slow' | 'heavy' | 'closed'; averageSpeedKph?: number; source?: 'sumo' | 'route-target' | 'network-range'; manual?: boolean };
type RoadDetour = { coordinates: [number, number][]; roadIds: string[]; distanceMeters: number; estimatedSeconds: number; congestionDelaySeconds: number; congestion: 'free' | 'slow' | 'heavy'; hazardPenaltySeconds: number; hazards: string[]; hazardDataAvailable: boolean; usefulnessScore: number; restrictionsApplied: boolean; badges: string[]; distanceRank: number };
type RoadClosure = { id: string; roadId: string; roadName: string; reason: string; durationMinutes: number; startedAt: number; expiresAt: number; remainingMs: number; detours: RoadDetour[] };
type SimulationEvent = { id: string; kind: 'closed' | 'reopened'; roadId: string; roadName: string; reason: string; message: string };
type TrafficSettings = { trafficVolume: number; slowThresholdVehicles: number; heavyThresholdVehicles: number; averageVehiclesPerRoadEnabled: boolean; averageVehiclesPerRoadMin: number; averageVehiclesPerRoadMax: number };
type RoadTrafficCommand = { roadId?: string; roadIds?: string[]; durationMinutes?: number; reason?: string; vehicles?: number };
type SimulationCommandValue = number | TrafficSettings | RoadTrafficCommand;
type RouteStep = { instruction: string; road: string; distanceMeters: number; durationSeconds: number; location: [number, number] | null };
type RouteOption = { distanceMeters: number; durationSeconds: number; coordinates: [number, number][]; steps: RouteStep[] };
type SimSnapshot = { id: string; status: 'paused' | 'playing'; step: number; speed: number; elapsedMinutes: number; vehicles: { id: number; roadId?: string; position: [number, number]; heading: number; speedKph?: number; detouring?: boolean; detourIndex?: number; manual?: boolean; closureId?: string | null }[]; roadTraffic: Record<string, RoadTraffic>; closures: RoadClosure[]; events: SimulationEvent[]; settings: TrafficSettings; manualTrafficControl?: { roadIds: string[]; vehicles: number } | null; engine?: { name: string; version: string; mode: string; demandVehiclesPerHour: number; departed: number; arrived: number; collisions: number }; metrics: { congestionIndex: number; averageSpeedKph: number; activeVehicles: number } };
type RoadClosureComparison = { closureId: string; roadId: string; baseline: SimSnapshot; after: SimSnapshot };
type SimulationReview = {
  source: 'road-network';
  savedAt: number;
  locationLabel: string;
  roadNetwork?: {
    averageSpeedKph: number;
    congestionIndex: number;
    activeVehicles: number;
    roadCount: number;
    freeRoads: number;
    slowRoads: number;
    heavyRoads: number;
    closedRoads: number;
    elapsedMinutes: number;
    step: number;
    trafficVolume: number;
  };

};

const simulationReviewStorageKey = 'urban-twin-last-simulation-review';

function readSimulationReview(): SimulationReview | null {
  try {
    const raw = localStorage.getItem(simulationReviewStorageKey);
    if (!raw) return null;
    const review = JSON.parse(raw) as SimulationReview;
    if (!review || review.source !== 'road-network' || !Number.isFinite(review.savedAt)) return null;
    return review;
  } catch { return null; }
}

function saveSimulationReview(review: SimulationReview) {
  try { localStorage.setItem(simulationReviewStorageKey, JSON.stringify(review)); } catch { /* Storage can be unavailable in private browsing. */ }
}

function distanceMeters(a: [number, number], b: [number, number]) {
  const radians = (n: number) => n * Math.PI / 180;
  const dLat = radians(b[0] - a[0]);
  const dLon = radians(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function roadsTouch(first: RoadModel, second: RoadModel) {
  const key = ([latitude, longitude]: [number, number]) => `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  const firstNodes = new Set(first.coordinates.map(key));
  return second.coordinates.some(point => firstNodes.has(key(point)));
}

function formatDistance(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(meters / 10) * 10)} m`;
}

function formatRoadModelDistance(meters: number) {
  return `${Math.round(meters).toLocaleString()} m`;
}

function countRoadStates(snapshot: SimSnapshot) {
  return Object.values(snapshot.roadTraffic).reduce((counts, road) => {
    counts[road.congestion] += 1;
    return counts;
  }, { free: 0, slow: 0, heavy: 0, closed: 0 });
}

function detourRankLabel(index: number) {
  return index === 0 ? '#1 Best overall' : `#${index + 1} Alternative`;
}

function formatCongestionLevel(level: RoadDetour['congestion']) {
  return level === 'heavy' ? 'High congestion in SUMO snapshot' : level === 'slow' ? 'Reduced speed in SUMO snapshot' : 'Free flow in SUMO snapshot';
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} sec`;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  return remainder ? `${minutes} min ${remainder} sec` : `${minutes} min`;
}

function displayRoadName(road: RoadModel) {
  const highway = road.highway.replace(/_/g, ' ');
  const name = road.name.trim();
  return name.toLowerCase() === `${highway} road`.toLowerCase() || name.toLowerCase().startsWith(`${highway} road`) || name.toLowerCase() === 'road'
    ? `Unnamed ${highway} (${formatDistance(road.lengthMeters)})`
    : name;
}

function summarizeDetourRoads(ids: string[], model: ModelData) {
  const roads = ids.map(id => model.roads.find(road => road.id === id)).filter((road): road is RoadModel => Boolean(road));
  const named = roads.map(displayRoadName).filter((name, index, all) => all.indexOf(name) === index);
  const meaningfulNames = named.filter(name => !name.startsWith('Unnamed '));
  if (meaningfulNames.length) {
    const shown = meaningfulNames.slice(0, 3);
    const extra = meaningfulNames.length > shown.length ? ` + ${meaningfulNames.length - shown.length} named roads` : '';
    return `${shown.join(' -> ')}${extra} | ${roads.length} OSM segments`;
  }
  const classes = new Map<string, number>();
  for (const road of roads) {
    const highway = road.highway.replace(/_/g, ' ');
    classes.set(highway, (classes.get(highway) || 0) + 1);
  }
  return `${[...classes].slice(0, 3).map(([highway, count]) => `${count} unnamed ${highway}`).join(', ')} | ${roads.length} OSM segments`;
}

function formatRemaining(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const totalDays = Math.floor(totalSeconds / 86400);
  if (totalDays >= 1) {
    const weeks = Math.floor(totalDays / 7);
    const days = totalDays % 7;
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    return [weeks ? `${weeks}w` : '', days ? `${days}d` : '', hours ? `${hours}h` : ''].filter(Boolean).join(' ') || 'less than 1h';
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function maxClosureDurationFor(unit: ClosureDurationUnit) {
  return closureDurationUnits.find(item => item.id === unit)?.max ?? 525_600;
}

function closureDurationToMinutes(amount: number, unit: ClosureDurationUnit) {
  return amount * (closureDurationUnits.find(item => item.id === unit)?.minutes ?? 1);
}

function formatClosureDuration(minutes: number) {
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

function countdownParts(milliseconds: number) {
  let seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const years = Math.floor(seconds / (365 * 24 * 60 * 60)); seconds %= 365 * 24 * 60 * 60;
  const months = Math.floor(seconds / (30 * 24 * 60 * 60)); seconds %= 30 * 24 * 60 * 60;
  const weeks = Math.floor(seconds / (7 * 24 * 60 * 60)); seconds %= 7 * 24 * 60 * 60;
  const days = Math.floor(seconds / (24 * 60 * 60)); seconds %= 24 * 60 * 60;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  return [minutes, hours, days, weeks, months, years];
}

function StopwatchDigits({ milliseconds, compact = false }: { milliseconds: number; compact?: boolean }) {
  const values = countdownParts(milliseconds);
  return <div className={`closure-stopwatch ${compact ? 'compact' : ''}`} role="timer" aria-label={`${values[5]} years ${values[4]} months ${values[3]} weeks ${values[2]} days ${values[1]} hours ${values[0]} minutes remaining`}>
    {closureDurationUnits.map((unit, index) => <span className="closure-stopwatch-unit" key={unit.id}><b>{String(values[index]).padStart(2, '0')}</b><small>{unit.short}</small></span>)}
  </div>;
}

function ClosureCountdown({ expiresAt, compact = false }: { expiresAt: number; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <StopwatchDigits milliseconds={Math.max(0, expiresAt - now)} compact={compact} />;
}

function formatReviewTime(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function weatherText(code: number) {
  if (code === 0) return 'Clear sky';
  if ([1, 2, 3].includes(code)) return code === 1 ? 'Mainly clear' : code === 2 ? 'Partly cloudy' : 'Overcast';
  if ([45, 48].includes(code)) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
  if ([95, 96, 99].includes(code)) return 'Thunderstorm';
  return 'Weather code ' + code;
}

function formatWeatherValidTime(value: number | string | undefined, timezone: string) {
  if (value === undefined || value === null || value === '') return 'valid time unavailable';
  const timestamp = typeof value === 'number' ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'valid time unavailable';
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: timezone || undefined }).format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
}

function windDirectionLabel(degrees: number) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round((((degrees % 360) + 360) % 360) / 45) % directions.length];
}

function MapWeatherCard({ location, report, error }: { location: LocationResult; report: WeatherReport | null; error: string }) {
  const current = report?.current;
  const units = report?.current_units;
  const intervalMinutes = Math.max(1, Math.round(Number(current?.interval || 900) / 60));
  return <section className="map-weather-card" aria-label={`Current weather estimate for ${location.name}`} aria-live="polite">
    <header><span className="map-weather-icon"><CloudRain size={15} /></span><span><b>Weather conditions</b><small>{location.name}{location.admin1 ? `, ${location.admin1}` : ''}</small></span><em>MODEL</em></header>
    {current && report ? <>
      <div className="map-weather-temperature"><strong>{Number(current.temperature_2m).toFixed(1)}°C</strong><span>{weatherText(Number(current.weather_code))}<small>Valid {formatWeatherValidTime(current.time, report.timezone)}</small></span></div>
      <div className="map-weather-grid">
        <span><small>Wind</small><b>{Number(current.wind_speed_10m).toFixed(1)} {units?.wind_speed_10m} {windDirectionLabel(Number(current.wind_direction_10m))}</b></span>
        <span><small>Precipitation · last {intervalMinutes} min</small><b>{Number(current.precipitation).toFixed(1)} {units?.precipitation}</b></span>
        <span><small>Wind gusts</small><b>{Number(current.wind_gusts_10m).toFixed(1)} {units?.wind_gusts_10m}</b></span>
        <span><small>Humidity</small><b>{Number(current.relative_humidity_2m).toFixed(0)}%</b></span>
      </div>
      <footer>{report.provider} · retrieved {new Date(report.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</footer>
    </> : <div className="map-weather-loading"><span className="search-spinner" />{error || 'Loading location weather…'}</div>}
  </section>;
}

function MapWeatherLayer({ report, reducedMotion }: { report: WeatherReport | null; reducedMotion: boolean }) {
  if (!report) return <div className="weather-layer-status" role="status"><CloudRain size={14} /> Loading location weather model…</div>;
  const current = report.current;
  const code = Number(current.weather_code) || 0;
  const precipitation = Number(current.precipitation) || 0;
  const rainActive = precipitation > 0 || Number(current.rain) > 0 || Number(current.showers) > 0 || (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
  const snowActive = (code >= 71 && code <= 77) || code === 85 || code === 86;
  const thunderActive = code === 95 || code === 96 || code === 99;
  const animated = !reducedMotion && (rainActive || snowActive || thunderActive);
  return <div className={`weather-map-layer ${rainActive ? 'rain-active' : ''} ${snowActive ? 'snow-active' : ''} ${thunderActive ? 'thunder-active' : ''}`} aria-label={`Open-Meteo weather layer: ${weatherText(code)}, ${precipitation.toFixed(1)} ${report.current_units.precipitation} precipitation`}>
    {animated && rainActive && Array.from({ length: 28 }, (_, index) => <i className="weather-drop" key={`rain-${index}`} style={{ left: `${(index * 37) % 100}%`, animationDelay: `${-(index % 9) * .11}s` }} />)}
    {animated && snowActive && Array.from({ length: 18 }, (_, index) => <i className="weather-snowflake" key={`snow-${index}`} style={{ left: `${(index * 29) % 100}%`, animationDelay: `${-(index % 11) * .4}s` }} />)}
    {animated && thunderActive && <i className="weather-lightning-flash" />}
    <div className="weather-layer-status" role="status"><CloudRain size={14} /><span><b>WEATHER MODEL</b><small>{weatherText(code)} · {precipitation.toFixed(1)} {report.current_units.precipitation} precipitation</small></span>{reducedMotion && <em>Motion reduced</em>}</div>
  </div>;
}

function App() {
  const [introVisible, setIntroVisible] = useState(true);
  const finishIntro = useCallback(() => setIntroVisible(false), []);
  const [activeTab, setActiveTab] = useState<'Twin' | 'Scenarios'>('Twin');
  const [zone, setZone] = useState('Search a location');
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('rutora-map-layers') || 'null') as Partial<Record<LayerKey, boolean>> | null;
      return saved ? { ...initialLayers, ...saved } : initialLayers;
    } catch { return initialLayers; }
  });
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [activePanel, setActivePanel] = useState<WorkspacePanel | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => localStorage.getItem('urban-twin-reduced-motion') === 'true');
  const [lastSimulationReview, setLastSimulationReview] = useState<SimulationReview | null>(readSimulationReview);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [roadClosed, setRoadClosed] = useState(false);
  const [demand, setDemand] = useState(0);
  const [simulated, setSimulated] = useState(false);
  const [scenarioRoadId, setScenarioRoadId] = useState('');
  const [scenarioName, setScenarioName] = useState('SUMO scenario');
  const [approved, setApproved] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [compareOpen, setCompareOpen] = useState(false);
  const [roadClosureComparison, setRoadClosureComparison] = useState<RoadClosureComparison | null>(null);
  const [roadClosureComparisonOpen, setRoadClosureComparisonOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [map3D, setMap3D] = useState(false);
  const [mapLayersOpen, setMapLayersOpen] = useState(false);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [scenarioPrompt, setScenarioPrompt] = useState('');
  const [appearance, setAppearance] = useState<Appearance>(() => (localStorage.getItem('urban-twin-appearance') as Appearance | null) ?? 'dark');
  const [fontFamily, setFontFamily] = useState<FontFamily>(() => (localStorage.getItem('urban-twin-font-family') as FontFamily | null) ?? 'dm-sans');
  const [fontScale, setFontScale] = useState<FontScale>(() => (localStorage.getItem('urban-twin-font-scale') as FontScale | null) ?? 'medium');
  const [weatherReport, setWeatherReport] = useState<WeatherReport | null>(null);
  const [weatherLocationId, setWeatherLocationId] = useState<number | null>(null);
  const [weatherError, setWeatherError] = useState('');
  const [apiHealth, setApiHealth] = useState<ApiHealth | null>(null);
  const [locationResults, setLocationResults] = useState<LocationResult[]>([]);
  const [location, setLocation] = useState<LocationResult | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [radiusMeters, setRadiusMeters] = useState(800);
  const [model, setModel] = useState<ModelData | null>(null);
  const [buildingModel, setBuildingModel] = useState(false);
  const [simulation, setSimulation] = useState<SimSnapshot | null>(null);
  const [simulationEditorCollapsed, setSimulationEditorCollapsed] = useState(false);
  const [simulationBusy, setSimulationBusy] = useState(false);
  const [simulationSpeed, setSimulationSpeed] = useState(1);
  const [simulationError, setSimulationError] = useState('');
  const [closingRoadId, setClosingRoadId] = useState<string | null>(null);
  const [closureDuration, setClosureDuration] = useState('1');
  const [closureDurationUnit, setClosureDurationUnit] = useState<ClosureDurationUnit>('minutes');
  const [closureReason, setClosureReason] = useState('');
  const [closureError, setClosureError] = useState('');
  const [roadControlMode, setRoadControlMode] = useState<'traffic' | 'closure'>('traffic');
  const [roadTrafficDraft, setRoadTrafficDraft] = useState('0');
  const [roadTrafficError, setRoadTrafficError] = useState('');
  const [trafficRoadIds, setTrafficRoadIds] = useState<string[]>([]);
  const [trafficRouteSelectionActive, setTrafficRouteSelectionActive] = useState(false);
  const [trafficSelectionError, setTrafficSelectionError] = useState('');
  const [closureNotice, setClosureNotice] = useState<SimulationEvent | null>(null);
  const [trafficDraft, setTrafficDraft] = useState<TrafficSettings>({ trafficVolume: 320, slowThresholdVehicles: 8, heavyThresholdVehicles: 16, averageVehiclesPerRoadEnabled: false, averageVehiclesPerRoadMin: 0, averageVehiclesPerRoadMax: 20 });
  const [destinationQuery, setDestinationQuery] = useState('');
  const [destinationResults, setDestinationResults] = useState<LocationResult[]>([]);
  const [destinationSearchOpen, setDestinationSearchOpen] = useState(false);
  const [destinationLoading, setDestinationLoading] = useState(false);
  const [destination, setDestination] = useState<LocationResult | null>(null);
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [gpsPosition, setGpsPosition] = useState<[number, number] | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState(0);
  const [gpsError, setGpsError] = useState('');
  const [gpsTracking, setGpsTracking] = useState(false);
  const [navigationActive, setNavigationActive] = useState(false);
  const [navigationStep, setNavigationStep] = useState(0);
  const [navigationHidden, setNavigationHidden] = useState(true);
  const [navigationPinned, setNavigationPinned] = useState(() => localStorage.getItem('urban-twin-navigation-pinned') === 'true');
  const [simulationFocus, setSimulationFocus] = useState(false);
  const [focusPhase, setFocusPhase] = useState<'map' | 'data'>('map');
  const tickTimer = useRef<number | undefined>(undefined);
  const focusTimer = useRef<number | undefined>(undefined);
  const focusScrollTimer = useRef<number | undefined>(undefined);
  const closureNoticeTimer = useRef<number | undefined>(undefined);
  const mapPanelRef = useRef<HTMLDivElement | null>(null);
  const lowerDataRef = useRef<HTMLElement | null>(null);

  const showClosureNotice = useCallback((event: SimulationEvent) => {
    window.clearTimeout(closureNoticeTimer.current);
    setClosureNotice(event);
    closureNoticeTimer.current = window.setTimeout(() => setClosureNotice(null), 6500);
  }, []);
  const acceptSimulationSnapshot = useCallback((snapshot: SimSnapshot) => {
    setSimulation(snapshot);
    (snapshot.events || []).forEach(showClosureNotice);
  }, [showClosureNotice]);

  useEffect(() => {
    const applyTheme = () => {
      const resolved = appearance === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : appearance;
      document.documentElement.dataset.appearance = appearance;
      document.documentElement.dataset.theme = resolved;
    };
    localStorage.setItem('urban-twin-appearance', appearance);
    applyTheme();
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [appearance]);

  useEffect(() => {
    const root = document.documentElement;
    const fontDefinitions: Record<FontFamily, { family: string; stack: string; googleName?: string }> = {
      'dm-sans': { family: 'DM Sans', stack: '"DM Sans", "Segoe UI", sans-serif' },
      atkinson: { family: 'Atkinson Hyperlegible', stack: '"Atkinson Hyperlegible", Arial, sans-serif' },
      system: { family: 'System default', stack: 'system-ui, "Segoe UI", sans-serif' },
      inter: { family: 'Inter', stack: 'Inter, "Segoe UI", sans-serif', googleName: 'Inter' },
      roboto: { family: 'Roboto', stack: 'Roboto, Arial, sans-serif', googleName: 'Roboto' },
      'open-sans': { family: 'Open Sans', stack: '"Open Sans", Arial, sans-serif', googleName: 'Open Sans' },
      lato: { family: 'Lato', stack: 'Lato, Arial, sans-serif', googleName: 'Lato' },
      montserrat: { family: 'Montserrat', stack: 'Montserrat, "Segoe UI", sans-serif', googleName: 'Montserrat' },
      poppins: { family: 'Poppins', stack: 'Poppins, "Segoe UI", sans-serif', googleName: 'Poppins' },
      'nunito-sans': { family: 'Nunito Sans', stack: '"Nunito Sans", "Segoe UI", sans-serif', googleName: 'Nunito Sans' },
      'source-sans': { family: 'Source Sans 3', stack: '"Source Sans 3", "Segoe UI", sans-serif', googleName: 'Source Sans 3' },
      'ibm-plex-sans': { family: 'IBM Plex Sans', stack: '"IBM Plex Sans", "Segoe UI", sans-serif', googleName: 'IBM Plex Sans' },
      'roboto-condensed': { family: 'Roboto Condensed', stack: '"Roboto Condensed", "Segoe UI", sans-serif', googleName: 'Roboto Condensed' },
      'work-sans': { family: 'Work Sans', stack: '"Work Sans", "Segoe UI", sans-serif', googleName: 'Work Sans' },
      'plus-jakarta': { family: 'Plus Jakarta Sans', stack: '"Plus Jakarta Sans", "Segoe UI", sans-serif', googleName: 'Plus Jakarta Sans' },
      'space-grotesk': { family: 'Space Grotesk', stack: '"Space Grotesk", "Segoe UI", sans-serif', googleName: 'Space Grotesk' },
      'fira-sans': { family: 'Fira Sans', stack: '"Fira Sans", "Segoe UI", sans-serif', googleName: 'Fira Sans' },
      ubuntu: { family: 'Ubuntu', stack: 'Ubuntu, "Segoe UI", sans-serif', googleName: 'Ubuntu' },
      'roboto-slab': { family: 'Roboto Slab', stack: '"Roboto Slab", Georgia, serif', googleName: 'Roboto Slab' },
      merriweather: { family: 'Merriweather', stack: 'Merriweather, Georgia, serif', googleName: 'Merriweather' },
      lora: { family: 'Lora', stack: 'Lora, Georgia, serif', googleName: 'Lora' },
      'space-mono': { family: 'Space Mono', stack: '"Space Mono", monospace', googleName: 'Space Mono' },
      'jetbrains-mono': { family: 'JetBrains Mono', stack: '"JetBrains Mono", monospace', googleName: 'JetBrains Mono' },
    };
    const selectedFont = fontDefinitions[fontFamily] ?? fontDefinitions['dm-sans'];
    let fontLink = document.getElementById('rutora-selected-font') as HTMLLinkElement | null;
    if (selectedFont.googleName) {
      if (!fontLink) {
        fontLink = document.createElement('link');
        fontLink.id = 'rutora-selected-font';
        fontLink.rel = 'stylesheet';
        document.head.appendChild(fontLink);
      }
      fontLink.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(selectedFont.googleName).replace(/%20/g, '+')}:wght@400;700&display=swap`;
    } else {
      fontLink?.remove();
    }
    root.style.setProperty('--font-body', selectedFont.stack);
    root.style.setProperty('--font-display', selectedFont.stack);
    root.style.setProperty('--font-scale', fontScale === 'low' ? '0.95' : fontScale === 'high' ? '1.18' : '1.06');
    localStorage.setItem('urban-twin-font-family', fontFamily);
    localStorage.setItem('urban-twin-font-scale', fontScale);
  }, [fontFamily, fontScale]);

  useEffect(() => {
    localStorage.setItem('rutora-map-layers', JSON.stringify(layers));
  }, [layers]);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/health', { signal: controller.signal }).then(response => response.json()).then(setApiHealth).catch(() => setApiHealth(null));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!location) {
      setWeatherReport(null);
      setWeatherLocationId(null);
      setWeatherError('');
      return;
    }
    const controller = new AbortController();
    const refresh = () => apiFetch(`/api/weather?latitude=${location.latitude}&longitude=${location.longitude}`, { signal: controller.signal })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Weather service is temporarily unavailable.');
        setWeatherReport(payload as WeatherReport);
        setWeatherLocationId(location.id);
        setWeatherError('');
      })
      .catch(error => { if (!controller.signal.aborted) setWeatherError(error instanceof Error ? error.message : 'Weather data is unavailable.'); });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10 * 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [location?.id, location?.latitude, location?.longitude]);

  useEffect(() => {
    localStorage.setItem('urban-twin-navigation-pinned', String(navigationPinned));
  }, [navigationPinned]);

  useEffect(() => {
    localStorage.setItem('urban-twin-reduced-motion', String(reducedMotion));
    document.documentElement.dataset.motion = reducedMotion ? 'reduced' : 'full';
  }, [reducedMotion]);

  useEffect(() => {
    if (!simulation || !model) return;
    const roadLevels = Object.values(simulation.roadTraffic ?? {});
    const review: SimulationReview = {
      source: 'road-network',
      savedAt: Date.now(),
      locationLabel: [model.location.name, model.location.admin1, model.location.country].filter(Boolean).join(', '),
      roadNetwork: {
        averageSpeedKph: simulation.metrics.averageSpeedKph,
        congestionIndex: simulation.metrics.congestionIndex,
        activeVehicles: simulation.metrics.activeVehicles,
        roadCount: roadLevels.length,
        freeRoads: roadLevels.filter(road => road.congestion === 'free').length,
        slowRoads: roadLevels.filter(road => road.congestion === 'slow').length,
        heavyRoads: roadLevels.filter(road => road.congestion === 'heavy').length,
        closedRoads: roadLevels.filter(road => road.congestion === 'closed').length,
        elapsedMinutes: simulation.elapsedMinutes,
        step: simulation.step,
        trafficVolume: simulation.settings.trafficVolume,
      },
    };
    setLastSimulationReview(review);
    saveSimulationReview(review);
  }, [simulation, model]);

  useEffect(() => {
    if (!compareOpen) return;
    const timer = window.setTimeout(() => document.querySelector('.comparison-panel')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' }), 120);
    return () => window.clearTimeout(timer);
  }, [compareOpen, reducedMotion]);

  useEffect(() => {
    if (!activePanel) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setActivePanel(null); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [activePanel]);

  useEffect(() => {
    if (!location) return;
    const tuckNavigationOnAction = (event: MouseEvent) => {
      if (navigationPinned) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest || target.closest('.navigation-card, .navigation-panel-toggle, .navigation-reopen, .gps-launcher')) return;
      if (target.closest('button, input, select, textarea, a, summary, [role="button"]')) setNavigationHidden(true);
    };
    document.addEventListener('click', tuckNavigationOnAction, true);
    return () => document.removeEventListener('click', tuckNavigationOnAction, true);
  }, [location, navigationPinned]);

  useEffect(() => {
    if (!simulation || (simulation.status !== 'playing' && !simulation.closures?.length)) {
      window.clearInterval(tickTimer.current);
      return;
    }
    tickTimer.current = window.setInterval(async () => {
      try {
        const response = await apiFetch(`/api/simulations/${simulation.id}/tick`);
        if (response.ok) acceptSimulationSnapshot(await response.json() as SimSnapshot);
      } catch { setSimulationError('Simulation connection lost.'); }
    }, 900);
    return () => window.clearInterval(tickTimer.current);
  }, [simulation?.id, simulation?.status, simulation?.closures?.length, acceptSimulationSnapshot]);

  useEffect(() => {
    if (!gpsTracking) return;
    if (!navigator.geolocation) {
      setGpsError('This browser does not support GPS location. Try a current browser on localhost or HTTPS.');
      setGpsTracking(false);
      return;
    }
    const watchId = navigator.geolocation.watchPosition(position => {
      const nextPosition: [number, number] = [position.coords.latitude, position.coords.longitude];
      setGpsPosition(nextPosition);
      setGpsAccuracy(position.coords.accuracy);
      setGpsError('');
      if (navigationActive && routeOptions[selectedRouteIndex]) {
        const steps = routeOptions[selectedRouteIndex].steps;
        setNavigationStep(current => {
          let next = current;
          while (next < steps.length - 1 && steps[next].location && distanceMeters(nextPosition, steps[next].location!) < 45) next += 1;
          return next;
        });
      }
    }, error => {
      const reasons: Record<number, string> = {
        1: 'Location permission is blocked. Allow location access for this site in your browser settings.',
        2: 'Your device could not determine its location. Check that location services are enabled.',
        3: 'GPS took too long. Try again outdoors or use a destination without turn-by-turn tracking.',
      };
      setGpsError(reasons[error.code] || 'Could not read your current location.');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [gpsTracking, navigationActive, routeOptions, selectedRouteIndex]);

  const reviewMetrics = useMemo(() => {
    const review = lastSimulationReview;
    if (review?.source === 'road-network' && review.roadNetwork) {
      const data = review.roadNetwork;
      const needsAttention = data.slowRoads + data.heavyRoads + data.closedRoads;
      const congestionTone = data.congestionIndex >= 70 ? 'danger' : data.congestionIndex >= 40 ? 'warn' : 'good';
      const attentionTone = data.heavyRoads + data.closedRoads ? 'danger' : data.slowRoads ? 'warn' : 'good';
      return [
        { icon: <Gauge size={17} />, label: 'Network speed', value: String(data.averageSpeedKph), unit: 'km/h', delta: 'MODEL OUTPUT', tone: 'good', foot: `${review.locationLabel} · road model` },
        { icon: <TrafficCone size={17} />, label: 'Congestion index', value: String(data.congestionIndex), unit: '/ 100', delta: data.congestionIndex >= 70 ? 'High' : data.congestionIndex >= 40 ? 'Moderate' : 'Low', tone: congestionTone, foot: `${data.freeRoads} free · ${data.slowRoads} slow · ${data.heavyRoads} red` },
        { icon: <Activity size={17} />, label: 'Active vehicles', value: data.activeVehicles.toLocaleString(), unit: '', delta: 'SIMULATED', tone: 'blue', foot: `${data.trafficVolume.toLocaleString()} base demand · ${data.roadCount} roads` },
        { icon: <AlertTriangle size={17} />, label: 'Roads needing attention', value: String(needsAttention), unit: `/${data.roadCount}`, delta: `${data.heavyRoads} red · ${data.closedRoads} closed`, tone: attentionTone, foot: `${data.slowRoads} slow · ${data.heavyRoads} at threshold · ${data.closedRoads} closed` },
        { icon: <Clock3 size={17} />, label: 'Simulation elapsed', value: String(data.elapsedMinutes), unit: 'min', delta: `STEP ${data.step}`, tone: 'blue', foot: `Last saved ${formatReviewTime(review.savedAt)}` },
      ];
    }
    return [
      { icon: <Gauge size={17} />, label: 'Network speed', value: '—', unit: 'km/h', delta: 'NO RUN DATA', tone: 'blue', foot: 'Run a simulation to populate this review' },
      { icon: <TrafficCone size={17} />, label: 'Congestion index', value: '—', unit: '/ 100', delta: 'NO RUN DATA', tone: 'blue', foot: 'Values come from the last saved run' },
      { icon: <Activity size={17} />, label: 'Active vehicles', value: '—', unit: '', delta: 'NO RUN DATA', tone: 'blue', foot: 'Values come from the last saved run' },
      { icon: <AlertTriangle size={17} />, label: 'Roads needing attention', value: '—', unit: '', delta: 'NO RUN DATA', tone: 'blue', foot: 'Values come from the last saved run' },
      { icon: <Clock3 size={17} />, label: 'Simulation elapsed', value: '—', unit: 'min', delta: 'NO RUN DATA', tone: 'blue', foot: 'Run a simulation to populate this review' },
    ];
  }, [lastSimulationReview]);

  const runSimulation = async () => {
    if (!model || !simulation) {
      setSimulationError('Select a location and create its SUMO road simulation first.');
      setScenarioOpen(false);
      focusDigitalTwinMap();
      return;
    }
    if (roadClosed && !scenarioRoadId) {
      setSimulationError('Select the mapped road you want to close.');
      return;
    }
    const requestedVolume = Math.max(10, Math.min(3000, Math.round(simulation.settings.trafficVolume * (1 + demand / 100))));
    let configured = simulation;
    if (requestedVolume !== simulation.settings.trafficVolume) {
      const result = await sendSimulationCommand('configure', { ...simulation.settings, trafficVolume: requestedVolume });
      if (!result) return;
      configured = result;
    }
    const baseline = configured;
    if (roadClosed && scenarioRoadId) {
      const result = await sendSimulationCommand('close-road', {
        roadId: scenarioRoadId,
        durationMinutes: 60,
        reason: scenarioName.trim().length >= 3 ? scenarioName.trim() : 'Planned scenario road closure',
      });
      if (!result) return;
      const closure = result.closures.find(item => item.roadId === scenarioRoadId);
      if (closure) {
        setRoadClosureComparison({ closureId: closure.id, roadId: scenarioRoadId, baseline, after: result });
        setRoadClosureComparisonOpen(true);
      }
    }
    setSimulated(true);
    setScenarioOpen(false);
    setActiveTab('Scenarios');
    if (simulation.status !== 'playing') void startSimulationPresentation();
  };
  const interpretPrompt = () => {
    const text = scenarioPrompt.toLowerCase();
    if (text.includes('open') && !text.includes('closure')) setRoadClosed(false);
    if (text.includes('clos') || text.includes('block') || text.includes('shut')) setRoadClosed(true);
    if (text.includes('peak') || text.includes('surge')) setDemand(85);
    if (text.includes('low traffic') || text.includes('reduced demand')) setDemand(20);
    setShowToast(true); window.setTimeout(() => setShowToast(false), 2400);
  };
  const searchLocation = async () => {
    const term = query.trim();
    if (term.length < 2 || locationLoading) return;
    setLocationLoading(true); setLocationError(''); setLocationResults([]); setSearchOpen(true);
    try {
      const response = await apiFetch(`/api/geocode?q=${encodeURIComponent(term)}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => null) as { error?: string } | null;
        if (response.status >= 500 && !errorData?.error) throw new Error('The local API is not responding. Stop this terminal and restart with "npm run dev" so the API starts with the app.');
        if (response.status === 503) throw new Error('The place-search provider is temporarily unavailable. Please retry in a moment.');
        throw new Error(errorData?.error || 'Location search is temporarily unavailable. Try again.');
      }
      const data = await response.json() as { results?: LocationResult[] };
      if (!data.results?.length) setLocationError('No matching locations. Try adding a city or country.');
      else setLocationResults(data.results);
    } catch (error) {
      setLocationError(error instanceof Error ? error.message : 'Could not search right now. Check your connection and try again.');
    } finally { setLocationLoading(false); }
  };
  const chooseLocation = (result: LocationResult) => { setLocation(result); setSimulationEditorCollapsed(false); setNavigationHidden(true); setClosingRoadId(null); setRoadClosureComparison(null); setRoadClosureComparisonOpen(false); setTrafficRoadIds([]); setTrafficRouteSelectionActive(false); setTrafficSelectionError(''); setZone(`${result.name}${result.admin1 ? `, ${result.admin1}` : ''}`); setSearchOpen(false); setLocationResults([]); setQuery(`${result.name}, ${result.country}`); setModel(null); setSimulation(null); setSimulationError(''); setSimulationSpeed(1); setTrafficDraft({ trafficVolume: 320, slowThresholdVehicles: 8, heavyThresholdVehicles: 16, averageVehiclesPerRoadEnabled: false, averageVehiclesPerRoadMin: 0, averageVehiclesPerRoadMax: 20 }); setDestination(null); setDestinationQuery(''); setRouteOptions([]); setRouteError(''); setNavigationActive(false); setGpsTracking(false); setNavigationStep(0); };
  const createLocationModel = async () => {
    if (!location || buildingModel) return;
    setSimulationEditorCollapsed(false);
    setBuildingModel(true); setSimulationError('');
    try {
      const response = await apiFetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, radiusMeters }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not build this road model.');
      const roadModel = payload as ModelData;
      setModel(roadModel);
      let rainMmH = weatherLocationId === location.id ? Number(weatherReport?.current.precipitation) || 0 : 0;
      if (weatherLocationId !== location.id) {
        try {
          const weatherResponse = await apiFetch(`/api/weather?latitude=${location.latitude}&longitude=${location.longitude}`);
          if (weatherResponse.ok) {
            const freshWeather = await weatherResponse.json() as WeatherReport;
            setWeatherReport(freshWeather);
            setWeatherLocationId(location.id);
            rainMmH = Number(freshWeather.current.precipitation) || 0;
          }
        } catch { /* The traffic scenario can run with dry-weather assumptions when weather is unavailable. */ }
      }
      const simResponse = await apiFetch('/api/simulations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: roadModel.id, trafficVolume: trafficDraft.trafficVolume, rainMmH }) });
      const simPayload = await simResponse.json();
      if (!simResponse.ok) throw new Error(simPayload.error || 'Road model created, but the simulation could not start.');
      setSimulation(simPayload as SimSnapshot);
      setTrafficDraft((simPayload as SimSnapshot).settings);
      setTrafficRoadIds((simPayload as SimSnapshot).manualTrafficControl?.roadIds ?? []);
    } catch (error) { setSimulationError(error instanceof Error ? error.message : 'Could not build this road model.'); }
    finally { setBuildingModel(false); }
  };
  const createSimulationForModel = async () => {
    if (!model || simulationBusy) return;
    setSimulationEditorCollapsed(false);
    setRoadClosureComparison(null);
    setRoadClosureComparisonOpen(false);
    setSimulationBusy(true); setSimulationError('');
    try {
      if (simulation?.status === 'playing') {
        const pauseResponse = await apiFetch('/api/simulations/' + simulation.id + '/command', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) });
        const pausePayload = await pauseResponse.json() as SimSnapshot & { error?: string };
        if (!pauseResponse.ok) throw new Error(pausePayload.error || 'Pause the current simulation before creating a new one.');
        acceptSimulationSnapshot(pausePayload);
      }
      const rainMmH = weatherLocationId === location?.id ? Number(weatherReport?.current.precipitation) || 0 : 0;
      const response = await apiFetch('/api/simulations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: model.id, trafficVolume: trafficDraft.trafficVolume, rainMmH }) });
      const payload = await response.json() as SimSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not create the simulation. Try again.');
      acceptSimulationSnapshot(payload);
      setTrafficDraft(payload.settings);
      setTrafficRoadIds(payload.manualTrafficControl?.roadIds ?? []);
      setSimulationSpeed(1);
      setClosingRoadId(null);
      if (simulationFocus) minimizeSimulationView();
    } catch (error) {
      setSimulationError(error instanceof Error ? error.message : 'Could not create the simulation. Try again.');
    } finally { setSimulationBusy(false); }
  };
  const sendSimulationCommand = async (action: 'play' | 'pause' | 'reset' | 'speed' | 'configure' | 'close-road' | 'open-road' | 'set-road-traffic' | 'clear-road-traffic', value?: SimulationCommandValue): Promise<SimSnapshot | null> => {
    if (!simulation) return null;
    setSimulationBusy(true); setSimulationError('');
    setRoadTrafficError('');
    try {
      const response = await apiFetch(`/api/simulations/${simulation.id}/command`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, value }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Simulation command failed.');
      const snapshot = payload as SimSnapshot;
      acceptSimulationSnapshot(snapshot);
      if (action === 'speed') setSimulationSpeed(typeof value === 'number' ? value : 1);
      if (action === 'reset') setSimulationSpeed(1);
      if (action === 'configure') setTrafficDraft((payload as SimSnapshot).settings);
      if (action === 'set-road-traffic') setTrafficRoadIds((payload as SimSnapshot).manualTrafficControl?.roadIds ?? []);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Simulation command failed.';
      setSimulationError(message);
      if (action === 'close-road') setClosureError(message);
      if (action === 'set-road-traffic' || action === 'clear-road-traffic') setRoadTrafficError(message);
      return null;
    }
    finally { setSimulationBusy(false); }
  };
  const selectRoadForClosure = (roadId: string) => {
    const road = model?.roads.find(item => item.id === roadId);
    if (trafficRouteSelectionActive) {
      if (!road) return;
      if (simulation?.closures.some(closure => closure.roadId === roadId)) {
        setTrafficSelectionError('A closed road cannot be added to this traffic route.');
        return;
      }
      if (trafficRoadIds.length >= 100) {
        setTrafficSelectionError('A manual traffic route can contain up to 100 road segments.');
        return;
      }
      if (trafficRoadIds.includes(roadId)) {
        setTrafficSelectionError('That segment is already selected. Use Undo to remove the last segment.');
        return;
      }
      const selectedRoads = trafficRoadIds.map(id => model?.roads.find(item => item.id === id)).filter((item): item is RoadModel => Boolean(item));
      if (selectedRoads.length && !selectedRoads.some(selected => roadsTouch(selected, road))) {
        setTrafficSelectionError('Choose a road that touches the selected route so the connection stays continuous.');
        return;
      }
      setTrafficRoadIds(current => [...current, roadId]);
      setTrafficSelectionError('');
      return;
    }
    if (!navigationPinned) setNavigationHidden(true);
    setClosingRoadId(roadId);
    setTrafficRoadIds([roadId]);
    setRoadControlMode(simulation?.closures.some(closure => closure.roadId === roadId) ? 'closure' : 'traffic');
    setRoadTrafficDraft(String(simulation?.roadTraffic[roadId]?.vehicles ?? 0));
    setRoadTrafficError('');
    setClosureDuration('1');
    setClosureDurationUnit('minutes');
    setClosureReason('');
    setClosureError('');
  };
  const startTrafficRouteSelection = () => {
    if (!trafficRoadIds.length) return;
    if (!navigationPinned) setNavigationHidden(true);
    const selectedTotal = trafficRoadIds.reduce((sum, id) => sum + (simulation?.roadTraffic[id]?.vehicles ?? 0), 0);
    setRoadTrafficDraft(String(selectedTotal));
    setRoadControlMode('traffic');
    setTrafficSelectionError('');
    setTrafficRouteSelectionActive(true);
    setClosingRoadId(null);
  };
  const finishTrafficRouteSelection = () => {
    if (!trafficRoadIds.length) return;
    const selectedTotal = trafficRoadIds.reduce((sum, id) => sum + (simulation?.roadTraffic[id]?.vehicles ?? 0), 0);
    const previousControl = simulation?.manualTrafficControl;
    setRoadTrafficDraft(String(previousControl && previousControl.roadIds.join('|') === trafficRoadIds.join('|') ? previousControl.vehicles : selectedTotal));
    setTrafficRouteSelectionActive(false);
    setTrafficSelectionError('');
    setClosingRoadId(trafficRoadIds[trafficRoadIds.length - 1]);
  };
  const undoTrafficRouteSelection = () => {
    setTrafficRoadIds(current => current.slice(0, -1));
    setTrafficSelectionError('');
  };
  const cancelTrafficRouteSelection = () => {
    setTrafficRouteSelectionActive(false);
    setTrafficSelectionError('');
    setTrafficRoadIds(simulation?.manualTrafficControl?.roadIds ?? []);
  };
  const dismissRoadControls = () => {
    setClosingRoadId(null);
    setTrafficRouteSelectionActive(false);
    setTrafficSelectionError('');
    setRoadTrafficError('');
    setTrafficRoadIds(simulation?.manualTrafficControl?.roadIds ?? []);
  };
  const applyTrafficRouteCount = async () => {
    const vehicles = Number(roadTrafficDraft);
    if (!Number.isInteger(vehicles) || vehicles < 0 || vehicles > 3000) {
      setRoadTrafficError('Enter a whole number of vehicles from 0 to 3,000.');
      return;
    }
    if (!trafficRoadIds.length) {
      setRoadTrafficError('Select one road or a connected route first.');
      return;
    }
    const applied = await sendSimulationCommand('set-road-traffic', { roadIds: trafficRoadIds, vehicles });
    if (applied) setClosingRoadId(null);
  };
  const submitRoadClosure = async () => {
    const amount = Number(closureDuration);
    const reason = closureReason.trim();
    const maximum = maxClosureDurationFor(closureDurationUnit);
    if (!Number.isInteger(amount) || amount < 1 || amount > maximum) { setClosureError(`Enter a whole duration from 1 to ${maximum.toLocaleString()} ${closureDurationUnit}.`); return; }
    if (reason.length < 3 || reason.length > 180) { setClosureError('Enter a reason between 3 and 180 characters.'); return; }
    if (!closingRoadId) return;
    const minutes = closureDurationToMinutes(amount, closureDurationUnit);
    const baseline = simulation;
    const after = await sendSimulationCommand('close-road', { roadId: closingRoadId, durationMinutes: minutes, reason });
    if (after) {
      const closure = after?.closures.find(item => item.roadId === closingRoadId);
      if (baseline && after && closure) {
        setRoadClosureComparison({ closureId: closure.id, roadId: closingRoadId, baseline, after });
        setRoadClosureComparisonOpen(false);
      }
      setClosingRoadId(null);
    }
    else setClosureError(simulationError || 'Could not close this road. Try again.');
  };
  const reopenRoad = async (roadId: string) => {
    const reopened = await sendSimulationCommand('open-road', { roadId });
    if (!reopened) setSimulationError('Could not reopen this road. Try again.');
    return reopened;
  };
  const reopenSelectedRoad = async () => {
    if (!closingRoadId) return;
    if (await reopenRoad(closingRoadId)) setClosingRoadId(null);
  };
  const focusDigitalTwinMap = () => {
    setActivePanel(null);
    setScenarioOpen(false);
    setActiveTab('Twin');
    window.setTimeout(() => mapPanelRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' }), 80);
  };
  const clearFocusTimers = () => {
    window.clearTimeout(focusTimer.current);
    window.clearTimeout(focusScrollTimer.current);
  };
  const minimizeSimulationView = () => {
    clearFocusTimers();
    setSimulationFocus(false);
    setFocusPhase('map');
    window.setTimeout(() => window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' }), 80);
  };
  const startSimulationPresentation = async () => {
    const started = await sendSimulationCommand('play');
    if (!started) return;
    clearFocusTimers();
    setSimulationFocus(true);
    setFocusPhase('map');
    window.setTimeout(() => mapPanelRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' }), 120);
    focusTimer.current = window.setTimeout(() => {
      setFocusPhase('data');
      focusScrollTimer.current = window.setTimeout(() => lowerDataRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' }), 650);
    }, 6500);
  };
  const searchDestination = async () => {
    const term = destinationQuery.trim();
    if (term.length < 2 || destinationLoading) return;
    setDestinationLoading(true); setRouteError(''); setDestinationResults([]); setDestinationSearchOpen(true);
    try {
      const response = await apiFetch(`/api/geocode?q=${encodeURIComponent(term)}`);
      const payload = await response.json().catch(() => null) as { results?: LocationResult[]; error?: string } | null;
      if (!response.ok) {
        if (response.status >= 500 && !payload?.error) throw new Error('The local API is not responding. Restart with "npm run dev" so the API starts with the app.');
        if (response.status === 503) throw new Error('The place-search provider is temporarily unavailable. Please retry in a moment.');
        throw new Error(payload?.error || 'Destination search is unavailable.');
      }
      if (!payload?.results?.length) setRouteError('No destination found. Try adding its city or country.');
      else setDestinationResults(payload.results);
    } catch (error) { setRouteError(error instanceof Error ? error.message : 'Destination search failed.'); }
    finally { setDestinationLoading(false); }
  };
  const locateMe = () => {
    if (!navigator.geolocation) { setGpsError('This browser does not support GPS.'); return; }
    setGpsError(''); setGpsTracking(true);
    navigator.geolocation.getCurrentPosition(position => {
      setGpsPosition([position.coords.latitude, position.coords.longitude]);
      setGpsAccuracy(position.coords.accuracy);
    }, error => {
      const reasons: Record<number, string> = { 1: 'Allow location access for this site in your browser settings.', 2: 'Your device could not determine its location. Check location services.', 3: 'GPS timed out. Try again outdoors.' };
      setGpsError(reasons[error.code] || 'Could not read your current location.');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  };
  const planRoute = async () => {
    if (!destination) { setRouteError('Search for and select a destination first.'); return; }
    let origin = gpsPosition;
    if (!origin && navigator.geolocation) {
      try {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }));
        origin = [position.coords.latitude, position.coords.longitude];
        setGpsPosition(origin); setGpsAccuracy(position.coords.accuracy); setGpsTracking(true); setGpsError('');
      } catch {
        setGpsError('To plan a route from your current location, allow GPS access. You can still pan the map and inspect the road model.');
        return;
      }
    }
    if (!origin) { setGpsError('Current location is unavailable. Allow GPS access in your browser.'); return; }
    setRouteLoading(true); setRouteError(''); setRouteOptions([]); setNavigationActive(false);
    try {
      const params = new URLSearchParams({ startLat: String(origin[0]), startLon: String(origin[1]), endLat: String(destination.latitude), endLon: String(destination.longitude) });
      const response = await apiFetch(`/api/route?${params}`);
      const payload = await response.json() as { routes?: RouteOption[]; error?: string };
      if (!response.ok || !payload.routes?.length) throw new Error(payload.error || 'No route could be found between these points.');
      setRouteOptions(payload.routes); setSelectedRouteIndex(0); setNavigationStep(0);
    } catch (error) { setRouteError(error instanceof Error ? error.message : 'Route planning failed. Check your connection and try again.'); }
    finally { setRouteLoading(false); }
  };
  const beginNavigation = () => {
    if (!routeOptions[selectedRouteIndex]) return;
    setGpsError(''); setNavigationStep(0); setGpsTracking(true); setNavigationActive(true);
  };
  const cycleAppearance = () => setAppearance(current => current === 'dark' ? 'light' : current === 'light' ? 'system' : 'dark');
  const toggleLayer = (key: LayerKey) => setLayers(current => ({ ...current, [key]: !current[key] }));
  const toggleApproval = () => { setApproved(value => !value); setShowToast(true); window.setTimeout(() => setShowToast(false), 2400); };

  useEffect(() => {
    if (!simulationFocus) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        minimizeSimulationView();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [simulationFocus]);

  useEffect(() => {
    if (!mapFullscreen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMapFullscreen(false);
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [mapFullscreen]);

  useEffect(() => () => {
    window.clearTimeout(focusTimer.current);
    window.clearTimeout(focusScrollTimer.current);
    window.clearTimeout(closureNoticeTimer.current);
  }, []);

  const closingRoad = model?.roads.find(road => road.id === closingRoadId) ?? null;
  const selectedTrafficRoads = trafficRoadIds.map(id => model?.roads.find(road => road.id === id)).filter((road): road is RoadModel => Boolean(road));
  const selectedTrafficVehicles = selectedTrafficRoads.reduce((sum, road) => sum + (simulation?.roadTraffic[road.id]?.sumoVehicles ?? simulation?.roadTraffic[road.id]?.vehicles ?? 0), 0);
  const currentRoadClosure = simulation?.closures?.find(closure => closure.roadId === closingRoadId) ?? null;

  return (
    <>
    <div aria-hidden={introVisible} className={`app-shell ${simulationFocus ? 'simulation-focus' : ''} ${simulationFocus && focusPhase === 'map' ? 'simulation-focus-map' : ''} ${simulationFocus && focusPhase === 'data' ? 'simulation-focus-data' : ''} ${mapFullscreen ? 'map-fullscreen' : ''}`}>
      <aside className={`sidebar ${drawer ? 'sidebar-open' : ''}`}>
        <div className="brand"><img className="brand-logo" src="/rutora-mark.svg" alt="" /><div><b>Rutora</b><small>URBAN INTELLIGENCE</small></div><button className="icon-button mobile-close" onClick={() => setDrawer(false)} aria-label="Close menu"><X size={18} /></button></div>
        <div className="workspace-label">WORKSPACE</div>
        <button className="workspace-switch" onClick={() => { focusDigitalTwinMap(); window.setTimeout(() => document.querySelector<HTMLInputElement>('.map-search input')?.focus(), 100); }}><div className="workspace-icon"><Building2 size={16} /></div><span><b>{location?.name || 'Select a location'}</b><small>{location ? [location.admin1, location.country].filter(Boolean).join(', ') : 'Search to load real map data'}</small></span><MapPin size={15} /></button>
        <div className="side-nav">
          <div className="nav-caption">MONITOR</div>
          <button className={`nav-item ${activeTab === 'Twin' && !activePanel ? 'active' : ''}`} onClick={() => { setDrawer(false); setActiveTab('Twin'); setActivePanel(null); setScenarioOpen(false); }}><MapIcon size={17} /><span>Digital twin</span>{simulation?.status === 'playing' && <i className="live-dot" />}</button>
          <button className={`nav-item ${activePanel === 'operations' ? 'active' : ''}`} onClick={() => { setDrawer(false); setActivePanel('operations'); }}><Activity size={17} /><span>Simulation ops</span><em>{simulation?.closures?.length ? simulation.closures.length : incidents.length}</em></button>
          <button className={`nav-item ${activePanel === 'incidents' ? 'active' : ''}`} onClick={() => { setDrawer(false); setActivePanel('incidents'); }}><AlertTriangle size={17} /><span>Incidents</span><em className="alert-count">{incidents.filter(incident => incident.severity === 'High').length}</em></button>
          <div className="nav-caption nav-caption-spaced">PLAN & ANALYZE</div>
          <button className={`nav-item ${activeTab === 'Scenarios' && scenarioOpen ? 'active' : ''}`} onClick={() => { setDrawer(false); setActiveTab('Scenarios'); setActivePanel(null); setScenarioOpen(true); }}><Sparkles size={17} /><span>Scenario studio</span></button>
          <button className={`nav-item ${compareOpen ? 'active' : ''}`} onClick={() => { setDrawer(false); setCompareOpen(value => !value); }}><BarChart3 size={17} /><span>Compare outcomes</span></button>
          <button className={`nav-item ${activePanel === 'predictions' ? 'active' : ''}`} onClick={() => { setDrawer(false); setActivePanel('predictions'); }}><TrendingUp size={17} /><span>Prediction models</span></button>
        </div>
        <div className="sidebar-bottom">
          <div className="twin-health"><div className="health-head"><span>Traffic simulation</span><span className="health-good">{simulation ? simulation.status === 'playing' ? 'Running' : 'Paused' : apiHealth?.engine?.available ? 'Ready' : 'Unavailable'}</span></div><div className="health-bar"><span style={{ width: apiHealth?.engine?.available ? '100%' : '0%' }} /></div><small>{simulation ? `${simulation.metrics.activeVehicles.toLocaleString()} modeled vehicles | no sensor feed` : apiHealth?.engine?.available ? `SUMO ${apiHealth.engine.version} installed locally` : 'SUMO runtime not detected'}</small></div>
          <button className={`nav-item settings ${activePanel === 'settings' ? 'active' : ''}`} onClick={() => { setDrawer(false); setActivePanel('settings'); }}><Settings2 size={17} /><span>Settings</span></button>
          <div className="profile"><div className="avatar">PS</div><div><b>Pranav Srivastava</b><small>City analyst</small></div><ChevronDown size={15} /></div>
        </div>
      </aside>
      {drawer && <button aria-label="Close navigation" className="scrim" onClick={() => setDrawer(false)} />}

      <main className="main-area">
        <header className="topbar">
          <div className="top-left"><button className="icon-button menu-button" onClick={() => setDrawer(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="crumb">Rutora <ChevronRight size={14} /> <b>{activeTab === 'Twin' ? 'Digital twin' : 'Scenario studio'}</b></div><span className="demo-tag"><span /> {simulation ? "SUMO SCENARIO" : "OPEN DATA SOURCES"}</span></div>
          <div className="top-actions">
            <div className="sync-status"><span className={"sync-pulse " + (simulation?.status === "playing" ? "" : "sync-off")} /> {simulation ? "SUMO " + simulation.status : "No traffic simulation running"}</div>
            <button className="theme-switch" onClick={cycleAppearance} title="Change appearance" aria-label={`Appearance: ${appearance}. Click to change`}>
              {appearance === 'dark' ? <Moon size={14} /> : appearance === 'light' ? <Sun size={14} /> : <Monitor size={14} />}
              <span>{appearance === 'system' ? 'System' : appearance === 'dark' ? 'Dark' : 'Light'}</span>
            </button>
            <button className="icon-button notification-button" aria-label="Incident source status" onClick={() => setActivePanel("incidents")}><Bell size={18} /></button>
            <div className="avatar top-avatar">PS</div>
          </div>
        </header>

        {activePanel && <div className="workspace-panel-backdrop" onClick={() => setActivePanel(null)}><section className="workspace-drawer" role="dialog" aria-modal="true" aria-labelledby="workspace-drawer-title" onClick={event => event.stopPropagation()}><div className="workspace-drawer-head"><div className={`workspace-drawer-icon ${activePanel}`}>
          {activePanel === 'operations' ? <Activity size={18} /> : activePanel === 'incidents' ? <AlertTriangle size={18} /> : activePanel === 'predictions' ? <TrendingUp size={18} /> : <Settings2 size={18} />}
        </div><div><span className="section-label">{activePanel === 'operations' ? 'CITY CONTROL' : activePanel === 'incidents' ? 'EVENT CENTER' : activePanel === 'predictions' ? 'FORECAST LAB' : 'PREFERENCES'}</span><h2 id="workspace-drawer-title">{activePanel === 'operations' ? 'Live operations' : activePanel === 'incidents' ? 'Incident center' : activePanel === 'predictions' ? 'Prediction models' : 'Settings'}</h2></div><button className="icon-button" onClick={() => setActivePanel(null)} aria-label="Close panel"><X size={18} /></button></div>

        {activePanel === 'operations' && <div className="workspace-drawer-content"><div className="operations-live-strip"><span className={`operations-live-dot ${simulation?.status === 'playing' ? 'playing' : ''}`} /><span><b>{simulation?.status === 'playing' ? 'SUMO simulation running' : simulation ? 'SUMO simulation paused' : 'No simulation loaded'}</b><small>{location ? `${zone} · local road model` : `${zone} · city overview`}</small></span><Radio size={16} /></div><div className="operations-stats"><div><small>Vehicles</small><b>{simulation?.metrics.activeVehicles.toLocaleString() ?? '—'}</b></div><div><small>Avg. speed</small><b>{simulation ? `${simulation.metrics.averageSpeedKph} km/h` : '—'}</b></div><div><small>Congestion</small><b>{simulation ? `${simulation.metrics.congestionIndex}/100` : '?'}</b></div></div><div className="drawer-section-heading"><span>Simulation controls</span>{simulation && <small>T+{simulation.elapsedMinutes} min</small>}</div>{simulation ? <button className="drawer-primary-action" onClick={() => void sendSimulationCommand(simulation.status === 'playing' ? 'pause' : 'play')}>{simulation.status === 'playing' ? <><Pause size={15} /> Pause simulation</> : <><Play size={15} fill="currentColor" /> Resume SUMO simulation</>}</button> : <div className="drawer-empty-state"><MapIcon size={18} /><span>Build a location road model to start vehicle-level operations.</span><button onClick={focusDigitalTwinMap}>Open digital twin <ArrowRight size={13} /></button></div>}{simulation?.closures?.length ? <><div className="drawer-section-heading"><span>Active road closures</span><em>{simulation.closures.length}</em></div>{simulation.closures.map(closure => <div className="drawer-closure-row" key={closure.id}><span><b>{closure.roadName}</b><small>{closure.reason} · {formatRemaining(closure.remainingMs)}</small></span><button onClick={() => void reopenRoad(closure.roadId)} disabled={simulationBusy}>Open</button></div>)}</> : <div className="operations-clear"><Check size={14} /> No active road closures</div>}<div className="drawer-section-heading"><span>Recent activity</span><button onClick={() => setActivePanel('incidents')}>All incidents <ArrowRight size={12} /></button></div><div className="drawer-incident-list">{incidents.slice(0, 3).map(incident => <button key={incident.id} onClick={() => { setSelectedIncident(incident); setLayers(current => ({ ...current, Incidents: true })); focusDigitalTwinMap(); }}><span className={`drawer-severity-dot ${incident.severity.toLowerCase()}`} /><span><b>{incident.title}</b><small>{incident.place} · {incident.time}</small></span><ChevronRight size={14} /></button>)}</div><button className="drawer-secondary-action" onClick={focusDigitalTwinMap}><MapIcon size={14} /> Open city map</button></div>}

        {activePanel === 'incidents' && <div className="workspace-drawer-content"><div className="incident-drawer-summary"><span className="incident-summary-count">0</span><span><b>Verified incident reports</b><small>No incident reporting service is connected</small></span></div><div className="drawer-empty-state"><AlertTriangle size={18} /><span>This workspace has no verified incident feed. Road closures you create for a SUMO scenario are listed under Scenario events.</span></div></div>}

        {activePanel === 'predictions' && <div className="workspace-drawer-content"><div className="prediction-drawer-intro"><span className="prediction-drawer-kicker"><TrendingUp size={14} /> SUMO MICROSIMULATION | {location?.name?.toUpperCase() || 'NO AREA SELECTED'}</span><div className="prediction-drawer-value">{simulation ? simulation.metrics.congestionIndex + '/100' : 'No run'}<small>modeled congestion index</small></div></div><div className="prediction-model-details"><div><span>Engine</span><b>{simulation?.engine ? 'SUMO ' + simulation.engine.version + ' | TraCI' : apiHealth?.engine?.available ? 'SUMO ' + apiHealth.engine.version + ' ready' : 'Unavailable'}</b></div><div><span>Traffic volume</span><b>{simulation ? simulation.settings.trafficVolume.toLocaleString() + ' configured departures/hour' : 'Set on a location run'}</b></div><div><span>Vehicles in network</span><b>{simulation ? simulation.metrics.activeVehicles.toLocaleString() : 'No simulation loaded'}</b></div><div><span>Simulation time</span><b>{simulation ? simulation.elapsedMinutes + ' modeled minutes' : '?'}</b></div></div><p className="prediction-disclaimer">SUMO produces modeled traffic from the OSM network and scenario demand. These are not live road sensor counts or a trained forecast.</p><button className="drawer-primary-action" onClick={() => { setActivePanel(null); focusDigitalTwinMap(); }}><MapIcon size={15} /> Open mapped simulation</button></div>}

        {activePanel === 'settings' && <div className="workspace-drawer-content"><section className="settings-group"><div className="settings-group-title"><span>Font family</span><small>Choose a readable interface typeface</small></div><label className="settings-select-row"><span>Typeface</span><select value={fontFamily} onChange={event => setFontFamily(event.target.value as FontFamily)}><optgroup label="Sans serif"><option value="dm-sans">DM Sans</option><option value="atkinson">Atkinson Hyperlegible</option><option value="inter">Inter</option><option value="roboto">Roboto</option><option value="open-sans">Open Sans</option><option value="lato">Lato</option><option value="montserrat">Montserrat</option><option value="poppins">Poppins</option><option value="nunito-sans">Nunito Sans</option><option value="source-sans">Source Sans 3</option><option value="ibm-plex-sans">IBM Plex Sans</option><option value="roboto-condensed">Roboto Condensed</option><option value="work-sans">Work Sans</option><option value="plus-jakarta">Plus Jakarta Sans</option><option value="space-grotesk">Space Grotesk</option><option value="fira-sans">Fira Sans</option><option value="ubuntu">Ubuntu</option></optgroup><optgroup label="Serif"><option value="roboto-slab">Roboto Slab</option><option value="merriweather">Merriweather</option><option value="lora">Lora</option></optgroup><optgroup label="Monospace"><option value="space-mono">Space Mono</option><option value="jetbrains-mono">JetBrains Mono</option></optgroup><optgroup label="Device fonts"><option value="system">System default</option></optgroup></select></label><small className="font-picker-note">Selected Google Fonts load on demand; system default works offline.</small></section><section className="settings-group"><div className="settings-group-title"><span>Font size</span><small>Adjust all interface text</small></div><div className="font-scale-options" role="group" aria-label="Font size">{(['low', 'medium', 'high'] as const).map(size => <button key={size} className={fontScale === size ? 'selected' : ''} onClick={() => setFontScale(size)} aria-pressed={fontScale === size}>{size[0].toUpperCase() + size.slice(1)}</button>)}</div></section><section className="settings-group"><div className="settings-group-title"><span>Appearance</span><small>Choose your interface theme</small></div><div className="appearance-options">{(['dark', 'light', 'system'] as const).map(mode => <button key={mode} className={appearance === mode ? 'selected' : ''} onClick={() => setAppearance(mode)}>{mode === 'dark' ? <Moon size={15} /> : mode === 'light' ? <Sun size={15} /> : <Monitor size={15} />}<span>{mode[0].toUpperCase() + mode.slice(1)}</span>{appearance === mode && <Check size={13} />}</button>)}</div></section><section className="settings-group"><div className="settings-group-title"><span>Map layers</span><small>Choose which data is drawn over the map</small></div><div className="settings-layer-list">{(['Traffic', 'Incidents', 'Disaster', 'Infrastructure'] as LayerKey[]).map((layer, index) => <label key={layer} title={layer === 'Incidents' ? 'Shows simulated closures and mapped diversions. Verified incident reports are not connected.' : layer === 'Disaster' ? 'Shows location-specific Open-Meteo precipitation and storm conditions.' : layer === 'Infrastructure' ? 'Shows OpenStreetMap building footprints in 2D and extruded buildings in 3D.' : 'Shows SUMO road-state colors and moving vehicles.'}><span className={`settings-layer-icon layer-${index}`}>{index === 0 ? <Activity size={14} /> : index === 1 ? <AlertTriangle size={14} /> : index === 2 ? <CloudRain size={14} /> : <Building2 size={14} />}</span><span>{layer}</span><input type="checkbox" checked={layers[layer]} onChange={() => toggleLayer(layer)} /><i /></label>)}</div></section><section className="settings-group"><div className="settings-group-title"><span>Motion & map</span><small>Personalize live map movement</small></div><label className="settings-motion-row"><span><b>Reduce motion</b><small>Stop animated traffic and interface transitions</small></span><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} /><i /></label><label className="settings-motion-row"><span><b>3D map view</b><small>Show the tilted city map</small></span><input type="checkbox" checked={map3D} onChange={event => setMap3D(event.target.checked)} /><i /></label></section><button className="settings-reset-button" onClick={() => { setAppearance('dark'); setFontFamily('dm-sans'); setFontScale('medium'); setLayers(initialLayers); setReducedMotion(false); setMap3D(false); setZone('Search a location'); }}>Reset interface preferences</button></div>}
        </section></div>}

        {simulationFocus && <div className="simulation-focus-toolbar"><span className="focus-live-label"><i />{focusPhase === 'map' ? 'LIVE SIMULATION · LOCATION VIEW' : 'SIMULATION RUNNING · LIVE DATA'}</span><small>The traffic model keeps running while you explore</small><button onClick={minimizeSimulationView}><X size={15} /> Minimize <kbd>Esc</kbd></button></div>}

        <section className="page-heading">
          <div><div className="eyebrow"><span className="eyebrow-line" /> URBAN INTELLIGENCE PLATFORM</div><h1>{activeTab === 'Twin' ? 'City digital twin' : 'Scenario studio'}</h1><p>{lastSimulationReview ? `Latest SUMO road-network run for ${lastSimulationReview.locationLabel} · saved ${formatReviewTime(lastSimulationReview.savedAt)}` : 'Run a simulation to populate these review cards. The latest run is saved in this browser.'}</p></div>
          <div className="heading-actions"><div className="select-wrap"><Compass size={15} /><span>{location?.name || "No area selected"}</span></div><button className="outline-button" onClick={() => setScenarioOpen(true)}><SlidersHorizontal size={15} /> Configure scenario</button><button className="primary-button" onClick={() => { setScenarioOpen(true); setActiveTab('Scenarios'); }}><Sparkles size={15} /> Run simulation</button></div>
        </section>

        <section className="metrics-row" aria-label="Latest simulation review">
          {reviewMetrics.map((metric, index) => <Metric key={`${lastSimulationReview?.source ?? 'empty'}-${index}`} {...metric} />)}
        </section>

        <section className="workspace-grid">
          <div ref={mapPanelRef} className="map-panel panel">
            <div className="map-topline"><div className="map-title"><div className="live-map-icon"><Radio size={15} /></div><div><b>{simulation ? 'SUMO urban simulation' : location ? 'Mapped road network' : 'Open map'}</b><small>{zone} <span>?</span> {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div></div><div className="map-head-actions"><div className="map-mode-tabs"><button className={!map3D ? 'selected' : ''} onClick={() => setMap3D(false)}>2D</button><button className={map3D ? 'selected' : ''} onClick={() => setMap3D(true)}>3D</button></div><button className="icon-button map-expand" onClick={() => setZoom(z => z === 1 ? 1.12 : 1)} title="Zoom map"><Crosshair size={17} /></button><button className="icon-button map-fullscreen-toggle" onClick={() => setMapFullscreen(value => !value)} aria-label={mapFullscreen ? 'Minimize map' : 'Expand map to full screen'} title={mapFullscreen ? 'Minimize map (Esc)' : 'Expand map to full screen'}>{mapFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button></div></div>
            <div className={`map-canvas ${location ? "location-active" : ""} ${location && weatherReport && weatherLocationId === location.id ? 'has-current-weather' : ''} ${location && mapLayersOpen ? 'layers-expanded' : ''}`}>
              <TwinMap hasLocation={Boolean(location)} zoom={zoom} />
              {location && layers.Disaster && !mapLayersOpen && <MapWeatherCard location={location} report={weatherLocationId === location.id ? weatherReport : null} error={weatherError} />}
              {map3D && !location && <div className="map3d-search-prompt"><span><Building2 size={15} /></span><div><b>Build a real 3D city model</b><small>Search a location for 3D buildings. Create its road model to add traffic and simulation overlays.</small></div><MapPin size={14} /></div>}
              <div className="map-search"><Search size={15} /><input aria-label="Search a location" placeholder="Search any city, place, or postcode..." value={query} onChange={e => { setQuery(e.target.value); setSearchOpen(false); setLocationResults([]); setLocationError(""); }} onKeyDown={e => { if (e.key === "Enter") void searchLocation(); if (e.key === "Escape") setSearchOpen(false); }} /><button className="map-search-submit" disabled={locationLoading} onClick={() => void searchLocation()} aria-label="Search locations">{locationLoading ? <span className="search-spinner" /> : <ArrowRight size={14} />}</button>{searchOpen && (locationResults.length > 0 || locationError) && <div className="location-results">{locationResults.map(result => <button key={result.id} onClick={() => chooseLocation(result)}><MapPin size={14} /><span><b>{result.name}</b><small>{[result.admin1, result.country].filter(Boolean).join(", ")}</small></span><ChevronRight size={14} /></button>)}{locationError && <div className="location-search-error">{locationError}</div>}</div>}</div>
              <div className="map-controls"><button onClick={() => setZoom(z => Math.min(1.2, z + .04))} aria-label="Zoom in"><Plus size={16} /></button><button onClick={() => setZoom(z => Math.max(.9, z - .04))} aria-label="Zoom out"><Minus size={16} /></button></div>
              <div className={`layer-control ${location ? 'location-layer-control' : ''} ${mapLayersOpen ? 'expanded' : ''}`}><button className="layer-heading" onClick={() => setMapLayersOpen(value => !value)} aria-expanded={!location || mapLayersOpen}><Layers3 size={14} /> MAP LAYERS {location && <ChevronDown size={12} />}</button>{(!location || mapLayersOpen) && (['Traffic', 'Incidents', 'Disaster', 'Infrastructure'] as LayerKey[]).map((layer, i) => <label key={layer} className="layer-option" title={layer === 'Incidents' ? 'Simulated closures and mapped diversions' : layer === 'Disaster' ? 'Weather model overlay' : layer === 'Infrastructure' ? 'Mapped building footprints and 3D buildings' : 'SUMO traffic state and moving vehicles'}><span className={`layer-symbol symbol-${i}`} />{layer}<input type="checkbox" checked={layers[layer]} onChange={() => toggleLayer(layer)} /><i className="checkmark"><Check size={11} /></i></label>)}</div>
              {layers.Traffic && <div className="map-legend"><span><i className="legend-line green" />Free flow</span><span><i className="legend-line amber" />Slow</span><span><i className="legend-line red" />Heavy</span></div>}
              <div className="map-attribution">SIMULATED CITY MAP <span>·</span> NOT FOR NAVIGATION</div>
              {selectedIncident && layers.Incidents && <div className="incident-popover"><button className="popover-close" aria-label="Close incident" onClick={() => setSelectedIncident(null)}><X size={13} /></button><div className={`severity-dot ${selectedIncident.severity.toLowerCase()}`} /> <b>{selectedIncident.title}</b><small>{selectedIncident.place} · {selectedIncident.time}</small><button className="popover-link" onClick={() => setScenarioOpen(true)}>View impact <ArrowRight size={12} /></button></div>}
              {location && <LocationMap location={location} model={model} simulation={simulation} radiusMeters={radiusMeters} route={routeOptions[selectedRouteIndex] ?? null} gpsPosition={gpsPosition} gpsAccuracy={gpsAccuracy} followGps={navigationActive} destination={destination} map3D={map3D} layers={layers} selectedTrafficRoadIds={trafficRoadIds} trafficRouteSelectionActive={trafficRouteSelectionActive} onSelectRoad={selectRoadForClosure} onMap3DChange={setMap3D} />}
              {location && layers.Disaster && <MapWeatherLayer report={weatherLocationId === location.id ? weatherReport : null} reducedMotion={reducedMotion} />}
              {location && trafficRouteSelectionActive && <div className="traffic-route-picker" role="status"><div className="traffic-route-picker-copy"><b>Select a connected traffic route</b><small>{trafficRoadIds.length} road segment{trafficRoadIds.length === 1 ? '' : 's'} selected · choose roads that touch</small>{trafficSelectionError && <em>{trafficSelectionError}</em>}</div><button onClick={undoTrafficRouteSelection} disabled={trafficRoadIds.length <= 1}>Undo</button><button className="traffic-route-picker-done" onClick={finishTrafficRouteSelection}>Use route</button><button className="traffic-route-picker-cancel" onClick={cancelTrafficRouteSelection}>Cancel</button></div>}
              {layers.Incidents && simulation?.closures?.length ? <div className="road-closure-stack">{simulation.closures.map(closure => <div className="road-closure-status" key={closure.id}><span className="closure-live-indicator" /><span className="closure-status-copy"><b>{closure.roadName} · closed</b><small>{closure.reason} · automatic reopening</small><ClosureCountdown expiresAt={closure.expiresAt} compact /><em>{closure.detours.length ? `${closure.detours.length} mapped alternate route${closure.detours.length === 1 ? '' : 's'} active` : 'No mapped detour · vehicles held at closure'}</em></span><div className="road-closure-actions">{roadClosureComparison?.closureId === closure.id && <button className={`road-compare-toggle ${roadClosureComparisonOpen ? 'selected' : ''}`} aria-expanded={roadClosureComparisonOpen} onClick={() => setRoadClosureComparisonOpen(value => !value)}><BarChart3 size={13} />{roadClosureComparisonOpen ? 'Hide compare' : 'Compare scenarios'}</button>}<button onClick={() => void reopenRoad(closure.roadId)} disabled={simulationBusy}>Reopen now</button></div></div>)}</div> : null}
              {closureNotice && <div className={`closure-notice ${closureNotice.kind}`} role="status"><span className="closure-notice-icon">{closureNotice.kind === 'closed' ? <Route size={16} /> : <PartyPopper size={17} />}</span><span><b>{closureNotice.kind === 'closed' ? 'Road blocked' : 'Congratulations! Road reopened'}</b><small>{closureNotice.message}</small></span><button onClick={() => setClosureNotice(null)} aria-label="Dismiss road update"><X size={14} /></button>{closureNotice.kind === 'reopened' && <span className="reopen-confetti" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</span>}</div>}
              {simulation?.closures?.some(closure => closure.detours.length > 0) && <div className="detour-route-key" aria-label="Detour colors ranked by usefulness"><b>Detour route key</b><small>Ranked by estimated time, traffic, and mapped hazards</small>{Array.from({ length: Math.max(...simulation.closures.map(closure => closure.detours.length)) }, (_, index) => <span key={index}><i style={{ backgroundColor: detourPalette[index % detourPalette.length] }} />{detourRankLabel(index)}</span>)}</div>}
              {roadClosureComparison && roadClosureComparisonOpen && model && <RoadClosureComparisonPanel comparison={roadClosureComparison} model={model} onClose={() => setRoadClosureComparisonOpen(false)} />}
              {location && navigationHidden && <button className={`gps-launcher ${gpsPosition ? 'located' : ''}`} onClick={() => setNavigationHidden(false)} aria-label="Open GPS navigation" title="Open GPS navigation"><MapPin size={21} /><i /></button>}
              {location && !navigationHidden && <section id="gps-navigation-panel" className={`navigation-card ${navigationPinned ? 'navigation-card-pinned' : ''}`} aria-label="GPS navigation">
                <div className="navigation-card-heading"><span className="navigation-icon"><Navigation size={16} /></span><span><b>GPS navigation</b><small>Route from your current location</small></span><button className={`navigation-float-toggle ${navigationPinned ? 'enabled' : ''}`} onClick={() => setNavigationPinned(value => !value)} aria-pressed={navigationPinned} title={navigationPinned ? 'Allow this panel to tuck away when you use other controls' : 'Keep this panel floating above dialogs and other panels'} aria-label={navigationPinned ? 'Turn off floating GPS panel' : 'Keep GPS panel floating over other panels'}><Layers3 size={14} /><span>{navigationPinned ? 'Pinned' : 'Float'}</span></button><button className={`gps-button ${gpsPosition ? 'located' : ''}`} onClick={locateMe} title="Use my current location"><LocateFixed size={15} />{gpsPosition ? 'GPS ready' : 'Locate me'}</button></div>
                <div className="destination-search"><Search size={14} /><input aria-label="Search a navigation destination" placeholder="Where do you want to go?" value={destinationQuery} onChange={e => { setDestinationQuery(e.target.value); setDestinationSearchOpen(false); setDestinationResults([]); setRouteError(''); }} onKeyDown={e => { if (e.key === 'Enter') void searchDestination(); if (e.key === 'Escape') setDestinationSearchOpen(false); }} /><button onClick={() => void searchDestination()} disabled={destinationLoading} aria-label="Search destination">{destinationLoading ? <span className="search-spinner" /> : <ArrowRight size={15} />}</button>
                  {destinationSearchOpen && destinationResults.length > 0 && <div className="destination-results">{destinationResults.map(result => <button key={result.id} onClick={() => { setDestination(result); setDestinationQuery([result.name, result.admin1, result.country].filter(Boolean).join(', ')); setDestinationSearchOpen(false); setDestinationResults([]); setRouteOptions([]); setRouteError(''); setNavigationActive(false); }}><MapPin size={14} /><span><b>{result.name}</b><small>{[result.admin1, result.country].filter(Boolean).join(', ')}</small></span></button>)}</div>}
                </div>
                {destination && <div className="destination-selected"><MapPin size={13} /><span>{destination.name}{destination.admin1 ? `, ${destination.admin1}` : ''}</span><button onClick={() => { setDestination(null); setRouteOptions([]); setNavigationActive(false); }}>Clear</button></div>}
                <button className="plan-route-button" onClick={() => void planRoute()} disabled={routeLoading || !destination}>{routeLoading ? <><span className="search-spinner" /> Finding a road route…</> : <><Route size={15} /> Find route <ArrowRight size={14} /></>}</button>
                {(gpsError || routeError) && <div className="navigation-error">{gpsError || routeError}</div>}
                {routeOptions[selectedRouteIndex] && <div className="route-result">
                  {routeOptions.length > 1 && <div className="route-options">{routeOptions.map((option, index) => <button key={`${index}-${option.distanceMeters}`} className={selectedRouteIndex === index ? 'selected' : ''} onClick={() => { setSelectedRouteIndex(index); setNavigationStep(0); setNavigationActive(false); }}><b>{formatDuration(option.durationSeconds)}</b><small>{formatDistance(option.distanceMeters)} · {index === 0 ? 'Recommended' : `Option ${index + 1}`}</small></button>)}</div>}
                  {routeOptions.length === 1 && <div className="route-summary"><b>{formatDuration(routeOptions[0].durationSeconds)}</b><span>{formatDistance(routeOptions[0].distanceMeters)} · driving</span></div>}
                  <div className="route-action-row">{navigationActive ? <button onClick={() => { setNavigationActive(false); setGpsTracking(false); }} className="stop-navigation"><Pause size={14} /> End navigation</button> : <button onClick={beginNavigation} className="start-navigation"><Navigation size={14} /> Start navigation</button>}<span>{navigationActive ? 'GPS tracking on' : `${routeOptions[selectedRouteIndex].steps.length} directions`}</span></div>
                  {navigationActive && routeOptions[selectedRouteIndex].steps[navigationStep] && <div className="next-direction"><Navigation size={16} /><span><b>Next</b>{routeOptions[selectedRouteIndex].steps[navigationStep].instruction}</span><small>{formatDistance(routeOptions[selectedRouteIndex].steps[navigationStep].distanceMeters)}</small></div>}
                  <details className="directions-list"><summary>Turn-by-turn directions <ChevronDown size={13} /></summary><ol>{routeOptions[selectedRouteIndex].steps.map((step, index) => <li key={`${index}-${step.instruction}`} className={index === navigationStep && navigationActive ? 'current' : ''}><span>{index + 1}</span><div><b>{step.instruction}</b><small>{formatDistance(step.distanceMeters)} · {formatDuration(step.durationSeconds)}</small></div></li>)}</ol></details>
                  <div className="routing-credit">Directions by OSRM · Map data &copy; OpenStreetMap</div>
                </div>}
              </section>}
              {location && (
                <div className={`location-model-card ${model ? "model-ready" : ""} ${simulationEditorCollapsed ? "editor-collapsed" : ""}`}>
                  <div className="location-model-head">
                    <span className="location-model-pin"><MapPin size={14} /></span>
                    <span><b>{model ? model.dataStatus === 'cached' ? "Cached road snapshot" : "Road model ready" : "Build a simulation model"}</b><small>{location.name}{location.admin1 ? `, ${location.admin1}` : ""} · {model?.dataStatus === 'cached' ? `OpenStreetMap snapshot${model.createdAt ? ` · saved ${new Date(model.createdAt).toLocaleDateString()}` : ''}` : 'OpenStreetMap road data'}</small></span>
                    {!simulationEditorCollapsed && <button className="location-exit" onClick={() => { setLocation(null); setModel(null); setSimulation(null); setRoadClosureComparison(null); setRoadClosureComparisonOpen(false); setMapFullscreen(false); setClosingRoadId(null); setTrafficRoadIds([]); setTrafficRouteSelectionActive(false); setNavigationActive(false); setGpsTracking(false); setRouteOptions([]); }}>Back to digital twin</button>}
                    <button className="location-editor-toggle" onClick={() => setSimulationEditorCollapsed(value => !value)} aria-expanded={!simulationEditorCollapsed} aria-label={simulationEditorCollapsed ? "Open simulation editor" : "Collapse simulation editor"} title={simulationEditorCollapsed ? "Open simulation editor" : "Collapse simulation editor"}>
                      {simulationEditorCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                      <span>{simulationEditorCollapsed ? "Open" : "Hide"}</span>
                    </button>
                  </div>
                  <div className="location-model-content" aria-hidden={simulationEditorCollapsed}>
                  {model && simulation ? (
                    <>
                      <div className="model-summary"><span><b>{model.summary.roadCount}</b><small>road segments</small></span><span><b>{model.summary.intersections}</b><small>intersections</small></span><span><b>{model.summary.networkKm} km</b><small>road network</small></span></div>
                      <button className="create-simulation-button" onClick={() => void createSimulationForModel()} disabled={simulationBusy}>{simulationBusy ? <><span className="search-spinner" /> Creating simulation...</> : <><Sparkles size={13} /> Create simulation</>}</button>
                      <div className="traffic-legend-row"><span><i className="free" />Free flow</span><span><i className="slow" />Slow</span><span><i className="heavy" />At red threshold</span><span><i className="closed" />Closed</span><span><i className="diversion" />Diversion</span><small>Click a road to tune its traffic or close it</small></div>
                      <div className="sim-controls">
                        <button className="sim-play" onClick={() => { if (simulation?.status === 'playing') void sendSimulationCommand('pause'); else if (simulationFocus) void sendSimulationCommand('play'); else void startSimulationPresentation(); }} disabled={simulationBusy || !simulation}>{simulation?.status === "playing" ? <><Pause size={14} /> Pause</> : <><Play size={14} fill="currentColor" /> Run simulation</>}</button>
                        <button className="sim-reset" onClick={() => void sendSimulationCommand("reset")} disabled={simulationBusy || !simulation} aria-label="Reset simulation"><RotateCcw size={14} /></button>
                        <button className="sim-speed" onClick={() => { const next = simulationSpeed === 1 ? 2 : simulationSpeed === 2 ? 4 : 1; void sendSimulationCommand("speed", next); }} disabled={simulationBusy || !simulation}><Zap size={12} /> {simulationSpeed}x</button>
                        <span className="sim-clock">T+{simulation?.elapsedMinutes ?? 0} min</span>
                      </div>
                      {simulation && <div className="sim-live-metrics"><span><i className={simulation.status === "playing" ? "sim-running-dot" : "sim-paused-dot"} />{simulation.status === "playing" ? "Running" : "Paused"}</span><span>Speed {simulation.metrics.averageSpeedKph} km/h</span><span>Congestion {simulation.metrics.congestionIndex}/100</span></div>}
                      <details className="traffic-tuning" open>
                        <summary><SlidersHorizontal size={13} /> Road traffic thresholds <ChevronDown size={13} /></summary>
                        <div className="threshold-inputs">
                          <label>Slow from<input type="number" min="1" max="500" value={trafficDraft.slowThresholdVehicles} onChange={e => setTrafficDraft(current => ({ ...current, slowThresholdVehicles: Number(e.target.value) }))} /><small>vehicles</small></label>
                          <label>Red from<input type="number" min="2" max="1000" value={trafficDraft.heavyThresholdVehicles} onChange={e => setTrafficDraft(current => ({ ...current, heavyThresholdVehicles: Number(e.target.value) }))} /><small>vehicles</small></label>
                        </div>
                        <div className="network-vehicle-range">
                          <label className="network-range-heading"><input type="checkbox" checked={trafficDraft.averageVehiclesPerRoadEnabled} onChange={event => setTrafficDraft(current => ({ ...current, averageVehiclesPerRoadEnabled: event.target.checked }))} /><span><b>Average vehicles per road range</b><small>Set a repeatable scenario load across the network for road colors.</small></span></label>
                          <div className="network-range-inputs"><label>Minimum<input type="number" min="0" max="1000" value={trafficDraft.averageVehiclesPerRoadMin} disabled={!trafficDraft.averageVehiclesPerRoadEnabled} onChange={event => setTrafficDraft(current => ({ ...current, averageVehiclesPerRoadMin: Number(event.target.value) }))} /></label><span>to</span><label>Maximum<input type="number" min="0" max="1000" value={trafficDraft.averageVehiclesPerRoadMax} disabled={!trafficDraft.averageVehiclesPerRoadEnabled} onChange={event => setTrafficDraft(current => ({ ...current, averageVehiclesPerRoadMax: Number(event.target.value) }))} /></label></div>
                          <small className="network-range-note">Counts stay within this range on each road. Applied road/route targets override it. The moving car markers and SUMO counts remain actual simulation output.</small>
                        </div>
                        <label className="traffic-volume">SUMO trip demand <b>{trafficDraft.trafficVolume.toLocaleString()} / hour</b><input type="range" min="10" max="3000" step="10" value={trafficDraft.trafficVolume} onChange={e => setTrafficDraft(current => ({ ...current, trafficVolume: Number(e.target.value) }))} /><small>Higher demand sends more simulated trips into the mapped network.</small></label>
                        <button className="apply-thresholds" onClick={() => void sendSimulationCommand('configure', trafficDraft)} disabled={!simulation || simulationBusy || trafficDraft.slowThresholdVehicles < 1 || trafficDraft.heavyThresholdVehicles <= trafficDraft.slowThresholdVehicles || trafficDraft.heavyThresholdVehicles > 1000 || trafficDraft.averageVehiclesPerRoadMin < 0 || trafficDraft.averageVehiclesPerRoadMax < trafficDraft.averageVehiclesPerRoadMin || trafficDraft.averageVehiclesPerRoadMax > 1000}>Apply traffic settings</button>
                        <small className="threshold-note">Set these before Play or while it runs. Limits scale by road class, lane count, and length.</small>
                      </details>
                    </>
                  ) : model ? (
                    <>
                      <div className="simulation-error" role="status">Road model is ready. Create its simulation to enable traffic controls.</div>
                      <button className="build-model-button" onClick={() => void createSimulationForModel()} disabled={simulationBusy}>{simulationBusy ? <><span className="search-spinner" /> Creating simulation...</> : <><Sparkles size={14} /> Create simulation <ArrowRight size={14} /></>}</button>
                    </>
                  ) : (
                    <>
                      <label className="radius-control"><span>Area radius <b>{(radiusMeters / 1000).toFixed(1)} km</b></span><input type="range" min="400" max="1500" step="100" value={radiusMeters} onChange={e => setRadiusMeters(+e.target.value)} /></label>
                      <button className="build-model-button" onClick={() => void createLocationModel()} disabled={buildingModel}>{buildingModel ? <><span className="search-spinner" /> Reading road network...</> : <><Sparkles size={14} /> Create simulation <ArrowRight size={14} /></>}</button>
                    </>
                  )}
                  {simulationError && <div className="simulation-error">{simulationError}</div>}
                  <div className="location-map-attribution">&copy; OpenStreetMap contributors · Geocoding: Open-Meteo / GeoNames <a href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=14/${location.latitude}/${location.longitude}`} target="_blank" rel="noreferrer">Full map <ExternalLink size={10} /></a></div>
                  </div>
                </div>
              )}
            </div>
            <div className="map-footer"><div>{simulation ? <><span className="footer-live" /> <b>SUMO modeled output</b><span className="footer-sep">|</span> {simulation.metrics.activeVehicles.toLocaleString()} active vehicles <span className="footer-sep">|</span> {simulation.settings.trafficVolume.toLocaleString()} configured departures/hour</> : location ? <>OpenStreetMap road model <span className="footer-sep">|</span> No live vehicle feed</> : "No location or traffic model loaded"}</div>{roadClosureComparison ? <button className="road-comparison-footer-toggle" aria-expanded={roadClosureComparisonOpen} onClick={() => setRoadClosureComparisonOpen(value => !value)}>{roadClosureComparisonOpen ? 'Hide comparison' : 'Compare scenarios'} <ArrowRight size={14} /></button> : <button onClick={() => setCompareOpen(v => !v)}>{compareOpen ? 'Hide comparison' : 'Compare with scenario'} <ArrowRight size={14} /></button>}</div>
          </div>

          <aside className="insights-column"><section className="panel current-weather-card"><div className="current-weather-head"><div><div className="section-label"><span className="spark-small"><CloudRain size={12} /></span> OPEN-METEO CURRENT MODEL</div><h2>{location ? location.name + ' weather' : 'Current weather'}</h2></div><CloudRain size={18} /></div>{weatherReport && weatherLocationId === location?.id ? <><div className="current-weather-main"><strong>{Number(weatherReport.current.temperature_2m).toFixed(1)}</strong><span>{weatherReport.current_units.temperature_2m}</span></div><div className="weather-condition">{weatherText(Number(weatherReport.current.weather_code))} | model valid at {formatWeatherValidTime(weatherReport.current.time, weatherReport.timezone)} ? retrieved {new Date(weatherReport.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div><div className="weather-data-grid"><span>Precipitation ? last {Math.round(Number(weatherReport.current.interval || 900) / 60)} min <b>{weatherReport.current.precipitation} {weatherReport.current_units.precipitation}</b></span><span>Rain <b>{weatherReport.current.rain} {weatherReport.current_units.rain}</b></span><span>Wind <b>{weatherReport.current.wind_speed_10m} {weatherReport.current_units.wind_speed_10m} {windDirectionLabel(Number(weatherReport.current.wind_direction_10m))}</b></span><span>Gusts <b>{weatherReport.current.wind_gusts_10m} {weatherReport.current_units.wind_gusts_10m}</b></span><span>Humidity <b>{weatherReport.current.relative_humidity_2m}%</b></span><span>Cloud <b>{weatherReport.current.cloud_cover}%</b></span></div></> : <div className="drawer-empty-state"><CloudRain size={17} /><span>{weatherError || (location ? 'Loading current weather model data...' : 'Search a location to request current weather data.')}</span></div>}<p className="real-data-note">Open-Meteo forecast model data | refreshed every 10 minutes | CC BY 4.0 attribution.</p></section><section className="panel current-weather-card"><div className="current-weather-head"><div><div className="section-label"><span className="spark-small"><Activity size={12} /></span> TRAFFIC ENGINE</div><h2>{simulation?.status === 'playing' ? 'SUMO is running' : simulation ? 'SUMO is paused' : 'No simulation running'}</h2></div><span className="metric-icon blue"><Gauge size={15} /></span></div><div className="prediction-model-details"><div><span>Engine status</span><b>{simulation?.engine ? 'SUMO ' + simulation.engine.version : apiHealth?.engine?.available ? 'Ready | SUMO ' + apiHealth.engine.version : apiHealth?.engine?.reason || 'Checking local engine...'}</b></div>{simulation && <><div><span>Active simulated vehicles</span><b>{simulation.metrics.activeVehicles.toLocaleString()}</b></div><div><span>Average modeled speed</span><b>{simulation.metrics.averageSpeedKph} km/h</b></div><div><span>Trip departures / arrivals</span><b>{simulation.engine?.departed ?? 0} / {simulation.engine?.arrived ?? 0}</b></div><div><span>Configured demand</span><b>{simulation.settings.trafficVolume.toLocaleString()} vehicles/hour</b></div></>}</div><p className="real-data-note">Road geometry is from OpenStreetMap. SUMO vehicles are simulated; the app has no live traffic sensor feed.</p></section></aside>
        </section>

        {compareOpen && (roadClosureComparison && model ? <RoadClosureComparisonPanel comparison={roadClosureComparison} model={model} onClose={() => setCompareOpen(false)} /> : <section className="panel comparison-panel"><div className="comparison-head"><div><div className="section-label">SCENARIO COMPARISON</div><h2>No before/after run captured</h2></div><button className="icon-button" onClick={() => setCompareOpen(false)} aria-label="Close comparison"><X size={17} /></button></div><div className="drawer-empty-state"><BarChart3 size={17} /><span>Run a SUMO scenario and close a mapped road to capture comparable before and after engine snapshots.</span><button onClick={() => { setCompareOpen(false); setActiveTab('Scenarios'); setScenarioOpen(true); }}>Configure scenario <ArrowRight size={13} /></button></div></section>)}

        <section ref={lowerDataRef} className={`bottom-grid ${simulationFocus && focusPhase === 'data' ? 'focus-data-reveal' : ''}`}><div className="panel incidents-panel"><div className="panel-heading compact"><div><div className="section-label">SCENARIO EVENTS</div><h2>Road closures <span className="count-badge">{simulation?.closures.length ?? 0}</span></h2></div><button className="text-action" onClick={focusDigitalTwinMap}>Open map <ArrowRight size={13} /></button></div>{simulation?.closures.length ? <div className="incident-list">{simulation.closures.map(closure => <div className="incident-row" key={closure.id}><span className="incident-marker marker-0"><Route size={14} /></span><span className="incident-name"><b>{closure.roadName}</b><small>{closure.reason}</small></span><span className="incident-time">{formatRemaining(closure.remainingMs)}</span><button className="text-action" onClick={() => void reopenRoad(closure.roadId)} disabled={simulationBusy}>Reopen</button></div>)}</div> : <div className="drawer-empty-state"><Route size={17} /><span>No roads are closed in the current SUMO scenario. Incident reports are not connected.</span></div>}</div><div className="panel sources-panel"><div className="panel-heading compact"><div><div className="section-label">DATA SOURCES</div><h2>Configured integrations</h2></div><Settings2 size={16} /></div><div className="source-list">{sources.map((source, index) => <div className="source-row" key={source.label}><span className={`source-icon source-${index}`}>{index === 0 ? <MapIcon size={14} /> : index === 1 ? <Activity size={14} /> : index === 2 ? <CloudRain size={14} /> : <Route size={14} />}</span><span><b>{source.label}</b><small>{source.detail}</small></span><span className={`source-status ${source.status}`}><i />{source.status === 'local' ? 'Local' : 'Public'}</span></div>)}</div></div></section><footer className="page-footer"><span>OpenStreetMap roads <i /> SUMO modeled traffic <i /> Open-Meteo weather | no live traffic sensor feed</span><span className="page-footer-status">{apiHealth?.engine?.available ? "SUMO " + apiHealth.engine.version + " ready" : "SUMO unavailable"}</span></footer>
      {closingRoad && <RoadTrafficControls
        road={closingRoad}
        selectedRoads={selectedTrafficRoads}
        trafficByRoad={simulation?.roadTraffic ?? {}}
        totalVehicles={selectedTrafficVehicles}
        manualControl={simulation?.manualTrafficControl ?? null}
        draft={roadTrafficDraft}
        onDraftChange={setRoadTrafficDraft}
        error={roadTrafficError}
        mode={roadControlMode}
        onModeChange={setRoadControlMode}
        busy={simulationBusy || !simulation}
        closure={currentRoadClosure}
        closureDuration={closureDuration}
        onClosureDurationChange={setClosureDuration}
        closureDurationUnit={closureDurationUnit}
        onClosureDurationUnitChange={unit => { setClosureDurationUnit(unit); setClosureDuration(current => Number(current) > maxClosureDurationFor(unit) ? '1' : current); }}
        closureReason={closureReason}
        onClosureReasonChange={setClosureReason}
        closureError={closureError}
        onDismiss={dismissRoadControls}
        onApplyTraffic={applyTrafficRouteCount}
        onStartRouteSelection={startTrafficRouteSelection}
        onClearTraffic={() => void sendSimulationCommand('clear-road-traffic')}
        onSubmitClosure={() => void submitRoadClosure()}
        onReopenRoad={() => void reopenSelectedRoad()}
      />}
      </main>

      {scenarioOpen && <div className="modal-backdrop" onClick={() => setScenarioOpen(false)}><section className="scenario-modal" onClick={event => event.stopPropagation()}><div className="modal-header"><div className="modal-icon"><Sparkles size={18} /></div><div><span className="section-label">SUMO SCENARIO</span><h2>Configure a traffic run</h2></div><button className="icon-button" onClick={() => setScenarioOpen(false)} aria-label="Close"><X size={18} /></button></div><p className="modal-intro">Run microscopic traffic simulation on the selected OpenStreetMap roads. SUMO generates vehicle trips from configured demand; these are modeled vehicles, not measured traffic counts.</p><label className="field-label">Describe a scenario in plain language<div className="prompt-row"><input className="text-field" value={scenarioPrompt} onChange={event => setScenarioPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') interpretPrompt(); }} placeholder="e.g. Close a road during peak demand" /><button onClick={interpretPrompt} title="Apply scenario settings"><ArrowRight size={14} /></button></div></label><label className="field-label scenario-name-label">Scenario name<input className="text-field" value={scenarioName} onChange={event => setScenarioName(event.target.value)} maxLength={80} /></label><div className="scenario-switch-row"><div className="scenario-switch-icon"><Route size={17} /></div><div><b>Close a mapped road</b><small>Apply closure in SUMO and recalculate routes</small></div><button className={`toggle ${roadClosed ? 'on' : ''}`} role="switch" aria-checked={roadClosed} onClick={() => setRoadClosed(value => !value)}><span /></button></div>{roadClosed && model && <label className="field-label">Road to close<select className="text-field scenario-road-select" value={scenarioRoadId} onChange={event => setScenarioRoadId(event.target.value)}><option value="">Choose a road segment</option>{model.roads.map(road => <option key={road.id} value={road.id}>{road.name} | {road.highway.replace(/_/g, ' ')} | {formatDistance(road.lengthMeters)}</option>)}</select></label>}<label className="slider-field"><span><b>Traffic demand change</b><small>+{demand}% from current configured departures per hour</small></span><input type="range" min="0" max="100" value={demand} onChange={event => setDemand(Number(event.target.value))} style={{ '--range': `${demand}%` } as React.CSSProperties} /><span className="range-ends"><i>Current demand</i><i>Double demand</i></span></label><div className="scenario-preview"><div className="preview-title"><Activity size={14} /> SUMO RUN INPUTS</div><div className="preview-stats"><span><small>Road network</small><b>{model ? model.summary.roadCount.toLocaleString() : 'Not built'} <i>OSM segments</i></b></span><span><small>Departures</small><b>{simulation ? Math.round(simulation.settings.trafficVolume * (1 + demand / 100)).toLocaleString() : '?'} <i>per hour</i></b></span><span><small>Weather input</small><b>{weatherReport && weatherLocationId === location?.id ? `${weatherReport.current.precipitation} ${weatherReport.current_units.precipitation}` : 'Unavailable'} <i>precipitation</i></b></span></div><small className="scenario-input-note">Weather is from Open-Meteo model data. SUMO output describes the scenario, not observed traffic.</small></div>{!simulation && <div className="scenario-setup-actions">{location && !model ? <button className="outline-button" onClick={() => { setScenarioOpen(false); focusDigitalTwinMap(); }}>Choose a location and build its road model</button> : model ? <button className="outline-button" onClick={() => void createSimulationForModel()} disabled={simulationBusy}>{simulationBusy ? 'Creating SUMO simulation...' : 'Create SUMO simulation'}</button> : <button className="outline-button" onClick={() => { setScenarioOpen(false); focusDigitalTwinMap(); }}>Open map to choose a location</button>}</div>}{simulationError && <div className="simulation-error" role="alert">{simulationError}</div>}<div className="modal-footer"><span><ShieldAlert size={14} /> Results come from the SUMO engine</span><button className="primary-button" onClick={() => void runSimulation()} disabled={!simulation || simulationBusy}><Sparkles size={14} /> Run SUMO scenario <ArrowRight size={14} /></button></div></section></div>}

      {activeTab === 'Scenarios' && <div className="scenario-result-dock"><div className="result-icon"><Sparkles size={17} /></div><div className="result-copy"><span className="section-label">{simulated ? 'SUMO SCENARIO RESULTS' : 'SCENARIO STUDIO'}</span><b>{simulated ? scenarioName : 'Configure a SUMO traffic run'}</b><small>{simulation ? `${location?.name || 'Selected area'} | ${simulation.settings.trafficVolume.toLocaleString()} modeled departures/hour | T+${simulation.elapsedMinutes} min` : 'Select an area and create its road model to start'}</small></div>{simulated && simulation && <><div className="dock-metric"><small>Active modeled vehicles</small><b>{simulation.metrics.activeVehicles.toLocaleString()}</b></div><div className="dock-metric"><small>Average SUMO speed</small><b>{simulation.metrics.averageSpeedKph} <i>km/h</i></b></div></>}<button className="outline-button" onClick={() => setCompareOpen(value => !value)}>{compareOpen ? 'Hide comparison' : 'Compare scenarios'}</button><button className={`approve-button ${approved ? 'approved' : ''}`} onClick={toggleApproval}>{approved ? <><Check size={14} /> Reviewed</> : 'Mark reviewed'}</button><button className="icon-button dock-close" onClick={() => setActiveTab('Twin')} aria-label="Close scenario results"><X size={17} /></button></div>}
      {showToast && <div className="toast"><Check size={15} /> {approved ? 'Scenario marked as reviewed' : 'Settings are up to date'}<button onClick={() => setShowToast(false)}><X size={13} /></button></div>}
    </div>
    {introVisible && <BrandIntro onComplete={finishIntro} reducedMotion={reducedMotion} />}
    </>
  );
}

const rutoraIntroScenes = [
  { title: 'The City Awakens', copy: 'A futuristic skyline appears. Neon signs and building outlines flicker on.', image: '/intro/scene-01-city.jpg', duration: 2000, tone: 'city' },
  { title: 'The Road Network Activates', copy: 'Neon lines trace the streets. Vehicles move through the connected network.', image: '/intro/scene-02-network.jpg', duration: 2000, tone: 'network' },
  { title: 'Unexpected Disruption', copy: 'A major road closes. Vehicles approaching the blockage stop.', image: '/intro/scene-03-disruption.jpg', duration: 2100, tone: 'disruption' },
  { title: 'RUTORA Takes Control', copy: 'Alternative routes illuminate. Vehicles move again along a new path.', image: '/intro/scene-04-reroute.jpg', duration: 2500, tone: 'reroute' },
  { title: '', copy: '', image: '/intro/scene-05-mark.jpg', duration: 1920, tone: 'logo' },
  { title: '', copy: '', image: '', duration: 5480, tone: 'brand' },
] as const;
const rutoraIntroTimelineMs = rutoraIntroScenes.reduce((total, scene) => total + scene.duration, 0);
const rutoraIntroFadeMs = 1000;

function BrandIntro({ onComplete, reducedMotion }: { onComplete: () => void; reducedMotion: boolean }) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const sceneTimers = useRef<number[]>([]);
  const finishTimer = useRef<number | undefined>(undefined);
  const beginExit = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    sceneTimers.current.forEach(window.clearTimeout);
    finishTimer.current = window.setTimeout(onComplete, rutoraIntroFadeMs);
  }, [onComplete]);

  useEffect(() => {
    document.documentElement.classList.add('rutora-intro-active');
    sceneTimers.current = [];
    let elapsed = 0;
    rutoraIntroScenes.slice(1).forEach((_, index) => {
      elapsed += rutoraIntroScenes[index].duration;
      sceneTimers.current.push(window.setTimeout(() => setSceneIndex(index + 1), elapsed));
    });
    sceneTimers.current.push(window.setTimeout(beginExit, rutoraIntroTimelineMs));
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') beginExit();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      sceneTimers.current.forEach(window.clearTimeout);
      sceneTimers.current = [];
      window.clearTimeout(finishTimer.current);
      window.removeEventListener('keydown', handleKeyDown);
      document.documentElement.classList.remove('rutora-intro-active');
    };
  }, [beginExit]);

  const scene = rutoraIntroScenes[sceneIndex];
  return <section className={`rutora-intro cinematic-intro ${closing ? 'is-closing' : ''} ${reducedMotion ? 'motion-static' : ''}`} data-intro-scene={sceneIndex} aria-label="Rutora cinematic introduction">
    <div className="cinema-backdrops" aria-hidden="true">
      {rutoraIntroScenes.map((item, index) => item.image && <div key={item.image} className={`cinema-backdrop cinema-backdrop-${item.tone} ${sceneIndex === index ? 'is-active' : ''} ${sceneIndex === index + 1 ? 'is-outgoing' : ''}`} style={{ backgroundImage: `url("${item.image}")`, '--scene-duration': `${item.duration}ms` } as React.CSSProperties} />)}
      <div className="cinema-vignette" />
      <div className="cinema-grain" />
      <div className="cinema-scanline" />
    </div>

    {sceneIndex === 5 && <div className="cinema-final-network" aria-hidden="true"><svg viewBox="0 0 1200 700" preserveAspectRatio="none"><path className="final-grid-road" d="M-40 142H215L282 206H520L610 135H1240M-40 284H182L254 350H488L566 284H760L842 340H1240M-40 500H204L278 438H520L604 520H872L956 450H1240M94 -20V183L150 238V460L94 520V740M332 -20V166L390 224V430L332 490V740M804 -20V173L738 237V420L804 486V740M1060 -20V198L1004 258V462L1060 522V740" /><path className="final-grid-route final-grid-route-pink" d="M-30 574H236L320 492H578L656 408H920L1010 324H1230" /><path className="final-grid-route final-grid-route-orange" d="M-30 86H254L326 158H576L680 252H956L1040 176H1230" /><circle cx="320" cy="492" r="4" /><circle cx="656" cy="408" r="4" /><circle cx="680" cy="252" r="4" /><circle cx="1040" cy="176" r="4" /></svg><i className="final-grid-signal signal-one" /><i className="final-grid-signal signal-two" /><i className="final-grid-signal signal-three" /></div>}

    {sceneIndex === 1 && <div className="cinema-network-overlay" aria-hidden="true"><svg viewBox="0 0 1200 700" preserveAspectRatio="none"><path d="M-30 510 C170 370 250 605 450 430 S720 270 885 390 S1085 520 1240 275" /><path d="M95 720 C195 535 120 360 350 255 S690 370 810 135 S1040 100 1210 -10" /><path d="M-30 285 C190 350 310 185 485 255 S790 450 980 250 S1110 215 1230 355" /></svg><i className="cinema-vehicle vehicle-one" /><i className="cinema-vehicle vehicle-two" /><i className="cinema-vehicle vehicle-three" /></div>}
    {sceneIndex === 2 && <div className="cinema-incident-overlay" aria-hidden="true"><svg viewBox="0 0 1200 700" preserveAspectRatio="none"><path d="M-30 470 C210 390 340 525 520 400 S850 285 1240 385" className="incident-road" /></svg><div className="cinema-closure-alert"><AlertTriangle size={16} /><span>NETWORK ALERT <b>ROAD CLOSED</b></span></div></div>}
    {sceneIndex === 3 && <div className="cinema-reroute-overlay" aria-hidden="true"><svg viewBox="0 0 1200 700" preserveAspectRatio="none"><path d="M-20 500 C170 430 270 565 405 445 S610 280 755 360 S995 500 1225 250" className="route-alternate route-alternate-secondary" /><path d="M-20 530 C165 475 280 585 440 480 S635 340 785 405 S1015 525 1225 295" className="route-alternate route-alternate-primary" /></svg><div className="cinema-route-chip"><Navigation size={15} /><span>ROUTE RECALCULATED</span></div></div>}
    {sceneIndex === 4 && <div className="cinema-logo-morph" aria-hidden="true"><svg viewBox="0 0 600 600"><path d="M80 510 C105 430 180 375 265 320 C350 265 410 220 390 155" /><path d="M80 510 C105 430 180 375 265 320 C350 265 410 220 390 155" className="logo-morph-core" /></svg><img src="/rutora-mark.svg" alt="" /><i className="morph-particle morph-particle-one" /><i className="morph-particle morph-particle-two" /><i className="morph-particle morph-particle-three" /></div>}

    {sceneIndex < 4 && <div className={`cinema-story-copy story-tone-${scene.tone}`} key={sceneIndex}><h1>{scene.title}</h1><p>{scene.copy}</p></div>}
    {sceneIndex === 5 && <div className="cinema-final-lockup" key="rutora-final-reveal"><img src="/rutora-mark.svg" alt="Rutora logo mark" /><div className="cinema-final-wordmark">RUTORA</div><div className="cinema-final-tagline">NAVIGATE BEYOND OBSTACLES</div><h1>Navigate Beyond Obstacle</h1><p>An AI Powered Urban Digital Twin</p></div>}
    <button className="cinema-skip" type="button" onClick={beginExit}>Skip <ArrowRight size={14} /></button>
  </section>;
}

type RoadTrafficControlsProps = {
  road: RoadModel;
  selectedRoads: RoadModel[];
  trafficByRoad: Record<string, RoadTraffic>;
  totalVehicles: number;
  manualControl: SimSnapshot['manualTrafficControl'];
  draft: string;
  onDraftChange: (value: string) => void;
  error: string;
  mode: 'traffic' | 'closure';
  onModeChange: (mode: 'traffic' | 'closure') => void;
  busy: boolean;
  closure: RoadClosure | null;
  closureDuration: string;
  onClosureDurationChange: (value: string) => void;
  closureDurationUnit: ClosureDurationUnit;
  onClosureDurationUnitChange: (value: ClosureDurationUnit) => void;
  closureReason: string;
  onClosureReasonChange: (value: string) => void;
  closureError: string;
  onDismiss: () => void;
  onApplyTraffic: () => void;
  onStartRouteSelection: () => void;
  onClearTraffic: () => void;
  onSubmitClosure: () => void;
  onReopenRoad: () => void;
};

function RoadTrafficControls({ road, selectedRoads, trafficByRoad, totalVehicles, manualControl, draft, onDraftChange, error, mode, onModeChange, busy, closure, closureDuration, onClosureDurationChange, closureDurationUnit, onClosureDurationUnitChange, closureReason, onClosureReasonChange, closureError, onDismiss, onApplyTraffic, onStartRouteSelection, onClearTraffic, onSubmitClosure, onReopenRoad }: RoadTrafficControlsProps) {
  const routeCount = selectedRoads.length;
  const targetVehicles = Number(draft);
  const canApply = Number.isInteger(targetVehicles) && targetVehicles >= 0 && targetVehicles <= 3000 && routeCount > 0;
  const sameAsManualRoute = Boolean(manualControl && manualControl.roadIds.join('|') === selectedRoads.map(item => item.id).join('|'));
  const targetPreview = Number.isFinite(Number(closureDuration)) ? closureDurationToMinutes(Math.max(0, Number(closureDuration)), closureDurationUnit) * 60_000 : 0;
  return <div className="modal-backdrop closure-backdrop" onClick={onDismiss}>
    <section className="road-closure-modal road-controls-modal" onClick={event => event.stopPropagation()}>
      <div className="modal-header">
        <div className="closure-modal-icon"><TrafficCone size={18} /></div>
        <div><span className="section-label">LIVE TRAFFIC CONTROL</span><h2>{routeCount > 1 ? `Connected route · ${routeCount} roads` : 'Road controls'}</h2></div>
        <button className="icon-button" onClick={onDismiss} aria-label="Close road controls"><X size={18} /></button>
      </div>
      <div className="closure-road-name"><MapPin size={15} /><span><b>{routeCount > 1 ? 'Selected connected route' : road.name}</b><small>{routeCount > 1 ? `${routeCount} connected road segments` : `${road.highway.replace(/_/g, ' ')} · ${road.lanes} lane${road.lanes === 1 ? '' : 's'} · ${formatDistance(road.lengthMeters)}`}</small></span></div>
      <div className="road-control-tabs" role="tablist" aria-label="Road action">
        <button role="tab" aria-selected={mode === 'traffic'} className={mode === 'traffic' ? 'selected' : ''} disabled={Boolean(closure)} onClick={() => onModeChange('traffic')}><Activity size={14} /> Traffic load</button>
        <button role="tab" aria-selected={mode === 'closure'} className={mode === 'closure' ? 'selected' : ''} disabled={routeCount > 1} onClick={() => onModeChange('closure')}><TrafficCone size={14} /> Road closure</button>
      </div>
      {mode === 'traffic' ? <>
        {closure ? <p className="closure-explanation">This road is closed. Reopen it before applying a manual traffic count.</p> : <>
          <div className="road-traffic-total"><span><small>SUMO vehicles moving on selection</small><b>{totalVehicles.toLocaleString()}</b></span><span><small>{sameAsManualRoute ? 'Applied scenario target' : 'Traffic state'}</small><b>{sameAsManualRoute ? `${manualControl?.vehicles.toLocaleString()} vehicles` : routeCount === 1 ? trafficByRoad[road.id]?.congestion ?? 'free' : 'Per road'}</b></span></div>
          <div className="road-traffic-segment-list">{selectedRoads.map(item => {
            const traffic = trafficByRoad[item.id];
            const trafficCount = traffic?.source === 'sumo'
              ? `${(traffic.sumoVehicles ?? traffic.vehicles).toLocaleString()} SUMO vehicles`
              : `${traffic?.vehicles.toLocaleString() ?? 0} ${traffic?.source === 'route-target' ? 'road target' : 'range target'} · ${traffic?.sumoVehicles ?? 0} SUMO now`;
            return <div className="road-traffic-segment" key={item.id}><span><b>{item.name}</b><small>{trafficCount} · slow at {traffic?.slowThreshold ?? '—'} · red at {traffic?.heavyThreshold ?? '—'}</small></span><em className={`traffic-state ${traffic?.congestion ?? 'free'}`}>{traffic?.congestion ?? 'free'}{traffic?.manual ? ' · target' : ''}</em></div>;
          })}</div>
          <label className="road-traffic-count">Target vehicles across {routeCount === 1 ? 'this road' : 'the selected route'}<span><input type="number" min="0" max="3000" step="1" value={draft} onChange={event => onDraftChange(event.target.value)} /><small>0–3,000</small></span></label>
          <input className="road-traffic-slider" type="range" min="0" max="3000" step="1" value={Number.isFinite(targetVehicles) ? Math.max(0, Math.min(3000, targetVehicles)) : 0} onChange={event => onDraftChange(event.target.value)} aria-label="Set vehicles on selected roads" />
          <div className="road-traffic-tools"><button className="outline-button" onClick={onStartRouteSelection} disabled={busy}><Route size={14} /> {routeCount > 1 ? 'Edit connected route' : 'Add connected roads'}</button>{manualControl && <button className="road-traffic-reset" onClick={onClearTraffic} disabled={busy}>Restore automatic flow</button>}</div>
          <small className="road-traffic-note">Applying updates each selected road’s color immediately using its scaled thresholds. SUMO moving-vehicle counts remain shown separately; a route target is split evenly across its segments.</small>
          {manualControl && <div className="manual-route-status">Manual control active on {manualControl.roadIds.length} road{manualControl.roadIds.length === 1 ? '' : 's'} · {manualControl.vehicles.toLocaleString()} target vehicles{sameAsManualRoute ? ' · editing this route' : ''}</div>}
          {error && <div className="closure-form-error" role="alert">{error}</div>}
          <div className="closure-modal-actions"><button className="outline-button" onClick={onDismiss}>Cancel</button><button className="apply-road-traffic" onClick={onApplyTraffic} disabled={busy || !canApply}><Activity size={14} /> {busy ? 'Applying…' : 'Apply vehicle count'}</button></div>
        </>}
      </> : closure ? <>
        <p className="closure-explanation">Vehicles are being diverted along the highlighted route. Automatic reopening countdown:</p>
        <ClosureCountdown expiresAt={closure.expiresAt} />
        <div className="closure-reason-summary"><b>Closure reason</b><span>{closure.reason}</span></div>
        <div className="closure-modal-actions"><button className="outline-button" onClick={onDismiss}>Keep closed</button><button className="reopen-road-button" onClick={onReopenRoad} disabled={busy}><Check size={14} /> Reopen now</button></div>
      </> : <>
        <p className="closure-explanation">Close this segment during the live simulation. Vehicles using it will divert onto the highlighted alternate path.</p>
        <div className="closure-field closure-duration-field"><span>Closure duration</span>
          <div className="closure-unit-selector" role="group" aria-label="Closure duration unit">{closureDurationUnits.map(unit => <button type="button" key={unit.id} className={closureDurationUnit === unit.id ? 'selected' : ''} aria-pressed={closureDurationUnit === unit.id} title={unit.label} onClick={() => onClosureDurationUnitChange(unit.id)}><b>{unit.short}</b><small>{unit.label}</small></button>)}</div>
          <div className="closure-duration-editor"><input type="number" min="1" max={maxClosureDurationFor(closureDurationUnit)} step="1" value={closureDuration} onChange={event => onClosureDurationChange(event.target.value)} aria-label={`Closure duration in ${closureDurationUnit}`} /><b>{closureDurationUnit.toUpperCase()}</b><span>Maximum: {maxClosureDurationFor(closureDurationUnit).toLocaleString()} {closureDurationUnit}</span></div>
          <StopwatchDigits milliseconds={targetPreview} />
          <small className="closure-duration-limit">Months use 30 days and years use 365 days. Closures can be set up to one year.</small>
        </div>
        <label className="closure-field">Reason for closure<textarea maxLength={180} rows={3} value={closureReason} onChange={event => onClosureReasonChange(event.target.value)} placeholder="e.g. Store delivery, road repair, planned event..." /></label>
        <div className="closure-form-hint"><Route size={14} /> Up to five connected alternatives are ranked by estimated drive time, modeled congestion, and mapped hazard tags. Motor-vehicle access and one-way rules are applied. Live weather and incident feeds are not linked to these routes.</div>
        {closureError && <div className="closure-form-error" role="alert">{closureError}</div>}
        <div className="closure-modal-actions"><button className="outline-button" onClick={onDismiss}>Cancel</button><button className="block-road-button" onClick={onSubmitClosure} disabled={busy}><TrafficCone size={14} /> {busy ? 'Applying...' : 'Block road and reroute'}</button></div>
      </>}
    </section>
  </div>;
}

function RoadClosureComparisonPanel({ comparison, model, onClose }: { comparison: RoadClosureComparison; model: ModelData; onClose: () => void }) {
  const road = model.roads.find(item => item.id === comparison.roadId);
  const closure = comparison.after.closures.find(item => item.id === comparison.closureId);
  if (!road || !closure) return null;

  const beforeRoads = countRoadStates(comparison.baseline);
  const afterRoads = countRoadStates(comparison.after);
  const signed = (value: number, suffix = '') => value > 0 ? `+${value.toLocaleString()}${suffix}` : value < 0 ? `−${Math.abs(value).toLocaleString()}${suffix}` : `0${suffix}`;
  const comparisonRows = [
    { label: 'Active vehicles', before: comparison.baseline.metrics.activeVehicles.toLocaleString(), after: comparison.after.metrics.activeVehicles.toLocaleString(), change: signed(comparison.after.metrics.activeVehicles - comparison.baseline.metrics.activeVehicles) },
    { label: 'Modeled average speed', before: `${comparison.baseline.metrics.averageSpeedKph} km/h`, after: `${comparison.after.metrics.averageSpeedKph} km/h`, change: signed(comparison.after.metrics.averageSpeedKph - comparison.baseline.metrics.averageSpeedKph, ' km/h') },
    { label: 'Congestion index', before: `${comparison.baseline.metrics.congestionIndex} / 100`, after: `${comparison.after.metrics.congestionIndex} / 100`, change: signed(comparison.after.metrics.congestionIndex - comparison.baseline.metrics.congestionIndex, ' pts') },
  ];

  return <section className="road-comparison-window" role="dialog" aria-label="Road closure scenario comparison">
    <header className="road-comparison-header">
      <span className="road-comparison-icon"><BarChart3 size={16} /></span>
      <div><span className="section-label">SCENARIO COMPARISON</span><b>Before and after road closure</b><small>{closure.roadName} · {closure.reason}</small></div>
      <button className="icon-button" onClick={onClose} aria-label="Close scenario comparison"><X size={16} /></button>
    </header>
    <div className="road-comparison-snapshot-labels"><span><i className="baseline-dot" />Baseline <small>T+{comparison.baseline.elapsedMinutes} min · step {comparison.baseline.step}</small></span><ArrowRight size={14} /><span><i className="closure-dot" />Closure scenario <small>T+{comparison.after.elapsedMinutes} min · step {comparison.after.step}</small></span></div>
    <div className="road-comparison-table" role="table" aria-label="Simulation metrics before and after closure">
      <div className="road-comparison-row road-comparison-table-head" role="row"><span role="columnheader">Metric</span><b role="columnheader">Before</b><b role="columnheader">After</b><b role="columnheader">Change</b></div>
      {comparisonRows.map(row => <div className="road-comparison-row" role="row" key={row.label}><span role="rowheader">{row.label}</span><b role="cell">{row.before}</b><b role="cell">{row.after}</b><em role="cell">{row.change}</em></div>)}
      <div className="road-comparison-row road-comparison-road-states" role="row"><span role="rowheader">Roads<br /><small>free / slow / red / closed</small></span><b role="cell">{beforeRoads.free} / {beforeRoads.slow} / {beforeRoads.heavy} / {beforeRoads.closed}</b><b role="cell">{afterRoads.free} / {afterRoads.slow} / {afterRoads.heavy} / {afterRoads.closed}</b><em role="cell">{signed(afterRoads.free - beforeRoads.free)} / {signed(afterRoads.slow - beforeRoads.slow)} / {signed(afterRoads.heavy - beforeRoads.heavy)} / {signed(afterRoads.closed - beforeRoads.closed)}</em></div>
    </div>
    <div className="road-comparison-routes">
      <div className="road-comparison-route-column"><span className="section-label">BASELINE ROAD</span><b>{road.name}</b><small>{road.highway.replace(/_/g, ' ')} · {road.lanes} lane{road.lanes === 1 ? '' : 's'}</small><div className="road-comparison-distance">{formatRoadModelDistance(road.lengthMeters)}</div><small>Mapped length of the selected road segment</small></div>
      <div className="road-comparison-route-column closure-route-column"><span className="section-label">CLOSURE · {formatClosureDuration(closure.durationMinutes)}</span><b>{closure.detours.length ? 'Best overall mapped bypass' : 'No connected bypass found'}</b>{closure.detours.length > 0 ? <><small>{formatDuration(closure.detours[0].estimatedSeconds)} · {formatRoadModelDistance(closure.detours[0].distanceMeters)} · {closure.detours[0].roadIds.length} mapped road segments</small><div className="road-comparison-distance">{formatCongestionLevel(closure.detours[0].congestion)}</div><small>Ranked by modeled time, congestion, and mapped hazard tags</small></> : <small>Vehicles remain at the closure in this model.</small>}</div>
    </div>
    {closure.detours.length > 0 && <div className="road-comparison-alternates"><b><Route size={13} /> Useful alternatives · ranked</b>{closure.detours.map((detour, index) => <div className={`road-comparison-alternate ${index === 0 ? 'shortest' : ''}`} key={`${closure.id}-${index}`}><i style={{ backgroundColor: detourPalette[index % detourPalette.length] }} /><span><b>{detourRankLabel(index)} <em>{detour.distanceRank === 1 ? 'Shortest' : ''}</em></b><small>{formatCongestionLevel(detour.congestion)} · modeled delay {formatDuration(detour.congestionDelaySeconds)}</small>{detour.hazards.length > 0 && <small>Mapped hazards: {detour.hazards.join(', ')}</small>}{detour.badges.length > 0 && <small>{detour.badges.join(' · ')}</small>}<small>{summarizeDetourRoads(detour.roadIds, model)}</small></span><strong>{formatDuration(detour.estimatedSeconds)}</strong><small>{formatRoadModelDistance(detour.distanceMeters)}</small></div>)}</div>}
    <div className="road-comparison-unmodeled"><b>Estimate scope</b><span>ETA uses mapped road class or OSM speed limit plus the simulation’s SUMO congestion snapshot. {closure.detours.every(detour => detour.restrictionsApplied) ? 'OpenStreetMap motor-vehicle access and one-way restrictions are applied.' : 'This cached road snapshot does not include complete access-restriction tags; restriction handling is approximate.'} {closure.detours.every(detour => detour.hazardDataAvailable) ? 'Mapped OSM hazard tags add route penalties (10 min for flood, landslide, or avalanche tags; 4 min for ford or poor-surface tags).' : 'Hazard tags were not saved with this cached snapshot, so the ranking cannot account for hazards.'} Rankings use estimated drive time plus mapped hazard penalties. These are planning estimates, not measured delay or proof of safety. Live weather and incident feeds are not connected to route ranking.</span></div>
    <p className="road-comparison-footnote">Road traffic comes from this simulation’s generated vehicle counts and configured thresholds. Route ETA and hazard weighting are planning estimates, not live sensor or verified safety data.</p>
  </section>;
}

type BuildingProperties = { osmId: number; name?: string | null; building?: string | null; levels?: number | null; height?: number | null; minHeight?: number | null };
type BuildingCollection = FeatureCollection<Geometry, BuildingProperties>;

function LocationMap({ location, model, simulation, radiusMeters, route, gpsPosition, gpsAccuracy, followGps, destination, map3D, layers, selectedTrafficRoadIds, trafficRouteSelectionActive, onSelectRoad, onMap3DChange }: { location: LocationResult; model: ModelData | null; simulation: SimSnapshot | null; radiusMeters: number; route: RouteOption | null; gpsPosition: [number, number] | null; gpsAccuracy: number; followGps: boolean; destination: LocationResult | null; map3D: boolean; layers: Record<LayerKey, boolean>; selectedTrafficRoadIds: string[]; trafficRouteSelectionActive: boolean; onSelectRoad: (roadId: string) => void; onMap3DChange: (enabled: boolean) => void }) {
  const center = useMemo<[number, number]>(() => [location.latitude, location.longitude], [location.latitude, location.longitude]);
  const [basemap, setBasemap] = useState<'street' | 'satellite'>('street');
  const [buildingFootprints, setBuildingFootprints] = useState<BuildingCollection | null>(null);
  const [buildingStatus, setBuildingStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'unavailable'>('idle');
  useEffect(() => {
    if (!layers.Infrastructure) return;
    const controller = new AbortController();
    setBuildingFootprints(null);
    setBuildingStatus('loading');
    apiFetch(`/api/buildings?latitude=${location.latitude}&longitude=${location.longitude}&radiusMeters=${model?.radiusMeters ?? radiusMeters}`, { signal: controller.signal })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Building data is unavailable.');
        setBuildingFootprints(payload as BuildingCollection);
        setBuildingStatus(payload.features?.length ? 'ready' : 'empty');
      })
      .catch(() => { if (!controller.signal.aborted) setBuildingStatus('unavailable'); });
    return () => controller.abort();
  }, [layers.Infrastructure, location.latitude, location.longitude, model?.radiusMeters, radiusMeters]);
  const attribution = basemap === 'satellite'
    ? satelliteAttribution
    : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const tiles = basemap === 'satellite'
    ? satelliteTileUrl
    : (import.meta.env.VITE_STREET_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  return <div className={`location-map-view ${map3D ? 'location-map-3d-active' : ''}`}>
    {map3D ? <LocationMap3D location={location} model={model} simulation={simulation} radiusMeters={radiusMeters} route={route} gpsPosition={gpsPosition} gpsAccuracy={gpsAccuracy} followGps={followGps} destination={destination} basemap={basemap} onBasemapChange={setBasemap} layers={layers} buildings={buildingFootprints} selectedTrafficRoadIds={selectedTrafficRoadIds} trafficRouteSelectionActive={trafficRouteSelectionActive} onSelectRoad={onSelectRoad} onMap3DChange={onMap3DChange} /> : <MapContainer key={String(location.id) + '-' + String(location.latitude)} center={center} zoom={15} scrollWheelZoom className={`leaflet-map ${basemap === 'satellite' ? 'leaflet-map-satellite' : ''}`}><TileLayer key={basemap} attribution={attribution} url={tiles} maxZoom={satelliteMaxZoom} maxNativeZoom={basemap === 'satellite' ? satelliteMaxZoom : 19} /><MapRecenter center={center} /><MapImageryZoom basemap={basemap} /><MapFollowGps position={gpsPosition} enabled={followGps} /><MapFitRoute coordinates={route?.coordinates ?? null} /><MapResizeObserver />
    <Circle center={center} radius={model?.radiusMeters ?? radiusMeters} pathOptions={{ color: '#42b991', fillColor: '#58d6ae', fillOpacity: .08, weight: 2, dashArray: '5 5' }} />
    {layers.Infrastructure && buildingFootprints && <GeoJSON data={buildingFootprints} style={() => ({ color: '#ab7e43', weight: 1, opacity: .76, fillColor: '#d6ae72', fillOpacity: .18 })} />}
    {model?.roads.map(road => {
      const traffic = simulation?.roadTraffic[road.id];
      const closure = simulation?.closures?.find(item => item.roadId === road.id);
      const selected = trafficRouteSelectionActive && selectedTrafficRoadIds.includes(road.id);
      const color = selected ? '#7658ed' : layers.Traffic && (closure || traffic?.congestion === 'heavy') ? '#df3e4f' : layers.Traffic && traffic?.congestion === 'slow' ? '#e39a2e' : layers.Traffic ? '#158b66' : '#71817b';
      const trafficSummary = !traffic
        ? '0 SUMO vehicles'
        : traffic.source === 'sumo'
          ? `${traffic.sumoVehicles ?? traffic.vehicles ?? 0} SUMO vehicles`
        : `${traffic?.vehicles ?? 0} scenario target · ${traffic?.sumoVehicles ?? 0} SUMO vehicles now`;
      return <Polyline key={road.id} positions={road.coordinates} eventHandlers={{ click: () => onSelectRoad(road.id) }} pathOptions={{ color, weight: selected ? 8 : road.highway === 'primary' || road.highway === 'trunk' ? 5 : 3, opacity: layers.Traffic ? .95 : .55, dashArray: closure && layers.Incidents ? '8 6' : undefined, className: 'road-segment' }}>{!trafficRouteSelectionActive && <Popup><div className="road-map-popup"><b>{road.name}</b><small>{road.highway.replace(/_/g, ' ')} · {road.lanes} lane{road.lanes === 1 ? '' : 's'}{road.oneway ? ' · one way' : ''}</small>{closure ? <><strong>ROAD CLOSED</strong><span>{closure.reason}</span><span>Reopens in {formatRemaining(closure.remainingMs)}</span></> : <><span>{trafficSummary} · slow at {traffic?.slowThreshold ?? '?'} · red at {traffic?.heavyThreshold ?? '?'}</span><button onClick={() => onSelectRoad(road.id)}>Manage this road...</button></>}</div></Popup>}</Polyline>;
    })}
    {layers.Incidents && simulation?.closures?.flatMap(closure => closure.detours.map((detour, index) => ({ closure, detour, index })).filter(({ detour }) => detour.coordinates.length >= 2 && detour.roadIds.length > 0).reverse().map(({ closure, detour, index }) => {
      const color = detourPalette[index % detourPalette.length];
      const routeLabel = index === 0 ? '#1 Best' : `#${index + 1} Alt`;
      const labelPoint = detour.coordinates[Math.floor((detour.coordinates.length - 1) / 2)];
      const icon = divIcon({ className: 'detour-map-label-shell', html: `<span style="--route-color:${color}">${routeLabel}</span>`, iconSize: [84, 25], iconAnchor: [42, 12] });
      return <Fragment key={`detour-${closure.id}-${index}`}>
        <Polyline positions={detour.coordinates} pathOptions={{ color, weight: index === 0 ? 7 : 5, opacity: .98, dashArray: index === 0 ? '12 7' : '8 8', lineCap: 'round', lineJoin: 'round', className: 'diversion-route-line' }}><Popup><div className="road-map-popup"><b>{detourRankLabel(index)} ? {closure.roadName}</b><small>Estimated {formatDuration(detour.estimatedSeconds)} ? {formatDistance(detour.distanceMeters)}</small><span>{formatCongestionLevel(detour.congestion)} ? {detour.hazards.length ? detour.hazards.join(', ') : 'No OpenStreetMap hazard tags'}</span><span>OSM access and one-way rules applied</span><span>{closure.reason} ? reopens in {formatRemaining(closure.remainingMs)}</span></div></Popup></Polyline>
        <Marker position={labelPoint} icon={icon} interactive={false} keyboard={false} />
      </Fragment>;
    }))}
    {route && <><Polyline positions={route.coordinates} pathOptions={{ color: '#fff', weight: 9, opacity: .9, lineCap: 'round', lineJoin: 'round' }} /><Polyline positions={route.coordinates} pathOptions={{ color: '#2878f0', weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' }} /></>}
    {destination && <CircleMarker center={[destination.latitude, destination.longitude]} radius={8} pathOptions={{ color: '#fff', weight: 2, fillColor: '#e34d5d', fillOpacity: 1 }}><Popup>{destination.name} | Destination</Popup></CircleMarker>}
    {gpsPosition && <><Circle center={gpsPosition} radius={Math.max(8, gpsAccuracy)} pathOptions={{ color: '#2878f0', fillColor: '#438cf2', fillOpacity: .1, weight: 1 }} /><CircleMarker center={gpsPosition} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#2878f0', fillOpacity: 1 }}><Popup>Your current location ? ?{Math.round(gpsAccuracy)} m</Popup></CircleMarker></>}
    <CircleMarker center={center} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#21aa7b', fillOpacity: 1 }}><Popup>{location.name} | Simulation area</Popup></CircleMarker>
    {layers.Traffic && simulation?.vehicles.map(vehicle => {
      const color = vehicle.detouring ? detourPalette[(vehicle.detourIndex ?? 0) % detourPalette.length] : vehicle.id % 5 === 0 ? '#df785f' : '#126ed3';
      return <Fragment key={vehicle.id}><CircleMarker center={vehicle.position} radius={11} interactive={false} pathOptions={{ color, weight: 0, fillColor: color, fillOpacity: simulation.status === 'playing' ? .2 : .12, className: 'simulation-vehicle-halo' }} /><CircleMarker center={vehicle.position} radius={6} pathOptions={{ color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, className: 'simulation-vehicle-core' }}><Tooltip direction="top" offset={[0, -7]}>{`SUMO vehicle ${vehicle.id + 1} · ${Math.round(vehicle.speedKph ?? 0)} km/h${vehicle.roadId ? ` · road ${vehicle.roadId}` : ''}`}</Tooltip></CircleMarker></Fragment>;
    })}
  </MapContainer>}
  {!map3D && <div className="basemap-switch" role="group" aria-label="Map imagery"><button className={basemap === 'street' ? 'selected' : ''} onClick={() => setBasemap('street')}><MapIcon size={13} />Street</button><button className={basemap === 'satellite' ? 'selected' : ''} onClick={() => setBasemap('satellite')}><Satellite size={13} />Satellite</button></div>}
  {layers.Infrastructure && !map3D && buildingStatus !== 'idle' && <div className="building-layer-status" role="status"><Building2 size={13} />{buildingStatus === 'loading' ? 'Loading mapped building footprints…' : buildingStatus === 'unavailable' ? 'Building service unavailable · retry by toggling layer' : buildingStatus === 'empty' ? 'No mapped building footprints in this area' : `${buildingFootprints?.features.length.toLocaleString() ?? '0'} OpenStreetMap building footprints`}</div>}
  <div className="location-map-badge"><span className="map-online-dot" />{map3D ? layers.Infrastructure ? '3D city view | OpenStreetMap buildings' : '3D streets | Infrastructure layer off' : model ? `${model.summary.roadCount} road segments | ${layers.Traffic ? (simulation?.metrics.activeVehicles.toLocaleString() ?? '0') + ' moving SUMO vehicles' : 'traffic overlay hidden'}` : 'Select area and build its road model'}</div>
  {!map3D && <div className="imagery-credit" hidden={basemap !== 'satellite'}><a href="https://goto.arcgisonline.com/maps/World_Imagery" target="_blank" rel="noreferrer">Esri World Imagery</a><span>· coverage varies by location</span></div>}
  {route && <div className="route-map-legend"><i /> Active GPS route</div>}</div>;
}

type CityMapProperties = Record<string, string | number | boolean | null>;
type CityMapFeature = Feature<Geometry, CityMapProperties>;
type CityMapCollection = FeatureCollection<Geometry, CityMapProperties>;
type City3DProps = {
  location: LocationResult;
  model: ModelData | null;
  simulation: SimSnapshot | null;
  radiusMeters: number;
  route: RouteOption | null;
  gpsPosition: [number, number] | null;
  gpsAccuracy: number;
  followGps: boolean;
  destination: LocationResult | null;
  basemap: 'street' | 'satellite';
  onBasemapChange: (basemap: 'street' | 'satellite') => void;
  layers: Record<LayerKey, boolean>;
  buildings: BuildingCollection | null;
  selectedTrafficRoadIds: string[];
  trafficRouteSelectionActive: boolean;
  onSelectRoad: (roadId: string) => void;
  onMap3DChange: (enabled: boolean) => void;
};

const emptyCityCollection = (): CityMapCollection => ({ type: 'FeatureCollection', features: [] });
const toLngLat = ([latitude, longitude]: [number, number]): [number, number] => [longitude, latitude];

function makeRadiusPolygon(location: LocationResult, radiusMeters: number): CityMapFeature {
  const earthRadius = 6_371_000;
  const centerLat = location.latitude * Math.PI / 180;
  const centerLon = location.longitude * Math.PI / 180;
  const angularRadius = radiusMeters / earthRadius;
  const coordinates: [number, number][] = [];
  for (let step = 0; step <= 64; step += 1) {
    const bearing = step / 64 * Math.PI * 2;
    const latitude = Math.asin(Math.sin(centerLat) * Math.cos(angularRadius) + Math.cos(centerLat) * Math.sin(angularRadius) * Math.cos(bearing));
    const longitude = centerLon + Math.atan2(Math.sin(bearing) * Math.sin(angularRadius) * Math.cos(centerLat), Math.cos(angularRadius) - Math.sin(centerLat) * Math.sin(latitude));
    coordinates.push([longitude * 180 / Math.PI, latitude * 180 / Math.PI]);
  }
  return { type: 'Feature', properties: { kind: 'area' }, geometry: { type: 'Polygon', coordinates: [coordinates] } };
}

function createCityMapData(props: City3DProps) {
  const roads: CityMapFeature[] = (props.model?.roads ?? []).map(road => {
    const traffic = props.simulation?.roadTraffic[road.id];
    const closed = props.simulation?.closures.some(closure => closure.roadId === road.id) ?? false;
    const congestion = closed ? 'closed' : traffic?.congestion ?? 'free';
    const priority = road.highway === 'motorway' || road.highway === 'trunk' || road.highway === 'primary'
      ? 'major'
      : road.highway === 'secondary' || road.highway === 'tertiary' ? 'collector' : 'local';
    return {
      type: 'Feature',
      properties: {
        roadId: road.id,
        roadName: road.name,
        highway: road.highway,
        priority,
        congestion,
        selected: props.trafficRouteSelectionActive && props.selectedTrafficRoadIds.includes(road.id),
        vehicles: traffic?.vehicles ?? 0,
        sumoVehicles: traffic?.sumoVehicles ?? traffic?.vehicles ?? 0,
        countSource: traffic?.source ?? 'sumo',
        slowThreshold: traffic?.slowThreshold ?? 0,
        heavyThreshold: traffic?.heavyThreshold ?? 0,
      },
      geometry: { type: 'LineString', coordinates: road.coordinates.map(toLngLat) },
    };
  });
  const detours: CityMapFeature[] = props.layers.Incidents ? (props.simulation?.closures ?? []).flatMap(closure => closure.detours.map((detour, index) => ({ closure, detour, index })).filter(({ detour }) => detour.coordinates.length >= 2 && detour.roadIds.length > 0).map(({ closure, detour, index }) => ({
    type: 'Feature' as const,
    properties: { roadName: closure.roadName, reason: closure.reason, routeRank: index + 1, routeLabel: index === 0 ? '#1 Best' : `#${index + 1} Alt`, color: detourPalette[index % detourPalette.length], distanceMeters: detour.distanceMeters },
    geometry: { type: 'LineString' as const, coordinates: detour.coordinates.map(toLngLat) },
  }))).reverse() : [];
  const route: CityMapFeature[] = props.route ? [{
    type: 'Feature',
    properties: { kind: 'navigation' },
    geometry: { type: 'LineString', coordinates: props.route.coordinates.map(toLngLat) },
  }] : [];
  const vehicles: CityMapFeature[] = (props.layers.Traffic ? props.simulation?.vehicles ?? [] : []).map(vehicle => ({
    type: 'Feature',
    properties: { kind: vehicle.detouring ? 'detour' : vehicle.id % 5 === 0 ? 'service' : 'vehicle', color: vehicle.detouring ? detourPalette[(vehicle.detourIndex ?? 0) % detourPalette.length] : vehicle.id % 5 === 0 ? '#df785f' : '#126ed3', speedKph: vehicle.speedKph ?? 0 },
    geometry: { type: 'Point', coordinates: toLngLat(vehicle.position) },
  }));
  const buildings: CityMapFeature[] = (props.buildings?.features ?? []).map(feature => ({
    type: 'Feature',
    properties: {
      osmId: feature.properties.osmId,
      name: feature.properties.name ?? null,
      building: feature.properties.building ?? null,
      levels: feature.properties.levels ?? null,
      height: feature.properties.height ?? null,
      minHeight: feature.properties.minHeight ?? null,
    },
    geometry: feature.geometry,
  }));
  const markers: CityMapFeature[] = [{
    type: 'Feature',
    properties: { kind: 'area', label: props.location.name },
    geometry: { type: 'Point', coordinates: [props.location.longitude, props.location.latitude] },
  }];
  if (props.gpsPosition) markers.push({
    type: 'Feature',
    properties: { kind: 'gps', label: 'Your location', accuracy: props.gpsAccuracy },
    geometry: { type: 'Point', coordinates: toLngLat(props.gpsPosition) },
  });
  if (props.destination) markers.push({
    type: 'Feature',
    properties: { kind: 'destination', label: 'Destination' },
    geometry: { type: 'Point', coordinates: [props.destination.longitude, props.destination.latitude] },
  });
  return {
    area: { type: 'FeatureCollection', features: [makeRadiusPolygon(props.location, props.model?.radiusMeters ?? props.radiusMeters)] } as CityMapCollection,
    roads: { type: 'FeatureCollection', features: roads } as CityMapCollection,
    detours: { type: 'FeatureCollection', features: detours } as CityMapCollection,
    route: { type: 'FeatureCollection', features: route } as CityMapCollection,
    vehicles: { type: 'FeatureCollection', features: vehicles } as CityMapCollection,
    buildings: { type: 'FeatureCollection', features: buildings } as CityMapCollection,
    markers: { type: 'FeatureCollection', features: markers } as CityMapCollection,
  };
}

function syncCityMapData(map: MapLibreMap, props: City3DProps) {
  const data = createCityMapData(props);
  (map.getSource('simulation-area') as GeoJSONSource | undefined)?.setData(data.area);
  (map.getSource('simulation-roads') as GeoJSONSource | undefined)?.setData(data.roads);
  (map.getSource('simulation-detours') as GeoJSONSource | undefined)?.setData(data.detours);
  (map.getSource('simulation-route') as GeoJSONSource | undefined)?.setData(data.route);
  (map.getSource('simulation-vehicles') as GeoJSONSource | undefined)?.setData(data.vehicles);
  (map.getSource('osm-building-footprints') as GeoJSONSource | undefined)?.setData(data.buildings);
  (map.getSource('simulation-markers') as GeoJSONSource | undefined)?.setData(data.markers);
}

function LocationMap3D(props: City3DProps) {
  const [panelHidden, setPanelHidden] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const baseFillLayerIdsRef = useRef<string[]>([]);
  const streetZoomRef = useRef<number | null>(null);
  const propsRef = useRef(props);
  const [pitch, setPitch] = useState(64);
  const [bearing, setBearing] = useState(-24);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState('');
  propsRef.current = props;

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let map: MapLibreMap | null = null;
    setMapReady(false);
    setMapError('');
    streetZoomRef.current = propsRef.current.basemap === 'satellite' ? 15.4 : null;
    const initialize = async () => {
      let maplibre: typeof import('maplibre-gl');
      try {
        const [module, worker] = await Promise.all([
          import('maplibre-gl'),
          import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);
        if (disposed || !containerRef.current) return;
        module.setWorkerUrl(worker.default);
        maplibre = module;
        map = new maplibre.Map({
          container: containerRef.current,
          style: 'https://tiles.openfreemap.org/styles/bright',
          center: [props.location.longitude, props.location.latitude],
          zoom: propsRef.current.basemap === 'satellite' ? 16 : 15.4,
          maxZoom: propsRef.current.basemap === 'satellite' ? satelliteMaxZoom : 22,
          pitch,
          bearing,
          maxPitch: 76,
          maxTileCacheSize: 160,
        });
      } catch {
        if (!disposed) setMapError('The 3D map could not start in this browser. Switch to 2D to continue.');
        return;
      }
      if (!map) return;
    const instance = map;
    mapRef.current = instance;
    instance.addControl(new maplibre.NavigationControl({ visualizePitch: true }), 'bottom-right');
    instance.addControl(new maplibre.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
    instance.on('load', () => {
      try {
      const styleLayers = instance.getStyle().layers ?? [];
      baseFillLayerIdsRef.current = styleLayers.filter(layer => layer.type === 'fill' && layer.layout?.visibility !== 'none').map(layer => layer.id);
      instance.addSource('satellite-imagery', {
        type: 'raster',
        tiles: [satelliteTileUrl],
        tileSize: 256,
        maxzoom: satelliteMaxZoom,
        attribution: satelliteAttribution,
      });
      const firstMapLayer = styleLayers.find(layer => layer.type !== 'background')?.id;
      instance.addLayer({ id: 'satellite-imagery-background', source: 'satellite-imagery', type: 'raster', layout: { visibility: propsRef.current.basemap === 'satellite' ? 'visible' : 'none' }, paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' } }, firstMapLayer);
      if (propsRef.current.basemap === 'satellite') baseFillLayerIdsRef.current.forEach(id => instance.setLayoutProperty(id, 'visibility', 'none'));

      const empty = emptyCityCollection();
      instance.addSource('simulation-area', { type: 'geojson', data: empty });
      instance.addLayer({ id: 'simulation-area-fill', source: 'simulation-area', type: 'fill', paint: { 'fill-color': '#42b887', 'fill-opacity': .075 } });
      instance.addLayer({ id: 'simulation-area-outline', source: 'simulation-area', type: 'line', paint: { 'line-color': '#37a879', 'line-width': 1.6, 'line-opacity': .8, 'line-dasharray': [2, 1.5] } });

      if (!instance.getStyle().sources.openmaptiles) throw new Error('The OpenFreeMap style did not provide its building vector tiles.');
      const labelLayerId = instance.getStyle().layers?.find(layer => layer.type === 'symbol' && layer.layout?.['text-field'])?.id;
      instance.addLayer({
        id: 'city-buildings-3d',
        source: 'openmaptiles',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 13.5,
        layout: { visibility: propsRef.current.layers.Infrastructure ? 'visible' : 'none' },
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['to-number', ['coalesce', ['get', 'render_height'], ['get', 'height'], 6], 6], 0, '#9eae9c', 12, '#b6b89f', 36, '#c7bea7', 100, '#d4d0c2'],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, ['to-number', ['coalesce', ['get', 'render_height'], ['get', 'height'], 6], 6]],
          'fill-extrusion-base': ['coalesce', ['to-number', ['get', 'render_min_height']], 0],
          'fill-extrusion-opacity': .96,
          'fill-extrusion-vertical-gradient': true,
        },
      }, labelLayerId);

      instance.addSource('osm-building-footprints', { type: 'geojson', data: empty });
      instance.addLayer({
        id: 'city-building-footprints-3d',
        source: 'osm-building-footprints',
        type: 'fill-extrusion',
        minzoom: 13,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': ['match', ['get', 'building'], 'commercial', '#b59c77', 'industrial', '#879b9b', 'retail', '#d0aa78', 'apartments', '#b49d83', '#a9bea9'],
          'fill-extrusion-height': ['to-number', ['coalesce', ['get', 'height'], 6], 6],
          'fill-extrusion-base': ['coalesce', ['to-number', ['get', 'minHeight']], 0],
          'fill-extrusion-opacity': .98,
          'fill-extrusion-vertical-gradient': true,
        },
      }, labelLayerId);

      instance.addSource('simulation-roads', { type: 'geojson', data: empty, lineMetrics: true });
      instance.addLayer({ id: 'city-roads-glow', source: 'simulation-roads', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
        'line-color': ['case', ['==', ['get', 'selected'], true], '#9a81ff', ['match', ['get', 'congestion'], 'slow', '#f3b64f', 'heavy', '#ef5861', 'closed', '#ef4858', '#30bd8a']],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 10], 'line-opacity': .2, 'line-blur': 4,
      } });
      instance.addLayer({ id: 'city-roads-line', source: 'simulation-roads', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
        'line-color': ['case', ['==', ['get', 'selected'], true], '#7658ed', ['match', ['get', 'congestion'], 'slow', '#e99f32', 'heavy', '#dc4651', 'closed', '#df3d50', '#16885f']],
        'line-width': ['case', ['==', ['get', 'selected'], true], ['interpolate', ['linear'], ['zoom'], 12, 3.4, 16, 8], ['interpolate', ['linear'], ['zoom'], 12, 1.2, 16, ['match', ['get', 'priority'], 'major', 4.4, 'collector', 3.1, 2.1]]],
        'line-opacity': .96,
      } });
      instance.addLayer({ id: 'city-road-closures', source: 'simulation-roads', type: 'line', filter: ['==', ['get', 'congestion'], 'closed'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff4c58', 'line-width': 2.2, 'line-dasharray': [1.2, 1.2] } });

      instance.addSource('simulation-detours', { type: 'geojson', data: empty });
      instance.addLayer({ id: 'city-detour-casing', source: 'simulation-detours', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 8, 'line-opacity': .8, 'line-dasharray': [1, .8] } });
      instance.addLayer({ id: 'city-detour-line', source: 'simulation-detours', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'routeRank'], 1], 6.5, 4.5], 'line-opacity': .98, 'line-dasharray': [1, .8] } });
      instance.addLayer({ id: 'city-detour-labels', source: 'simulation-detours', type: 'symbol', layout: { 'symbol-placement': 'line-center', 'text-field': ['get', 'routeLabel'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 2, 'text-halo-blur': .25 } });

      instance.addSource('simulation-route', { type: 'geojson', data: empty });
      instance.addLayer({ id: 'city-route-casing', source: 'simulation-route', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 10, 'line-opacity': .92 } });
      instance.addLayer({ id: 'city-route-line', source: 'simulation-route', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2878f0', 'line-width': 5, 'line-opacity': 1 } });

      instance.addSource('simulation-vehicles', { type: 'geojson', data: empty });
      instance.addLayer({ id: 'city-vehicle-halos', source: 'simulation-vehicles', type: 'circle', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 9, 16, 15],
        'circle-color': ['get', 'color'], 'circle-blur': .7, 'circle-opacity': .34,
      } });
      instance.addLayer({ id: 'city-vehicles', source: 'simulation-vehicles', type: 'circle', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4.5, 16, 7],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': 1,
      } });
      instance.addSource('simulation-markers', { type: 'geojson', data: empty });
      instance.addLayer({ id: 'city-location-markers', source: 'simulation-markers', type: 'circle', paint: {
        'circle-radius': ['match', ['get', 'kind'], 'gps', 8, 'destination', 8, 7],
        'circle-color': ['match', ['get', 'kind'], 'gps', '#2878f0', 'destination', '#e3485b', '#22aa7a'],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5, 'circle-opacity': 1,
      } });
      instance.addLayer({ id: 'city-location-labels', source: 'simulation-markers', type: 'symbol', layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.35], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#203a30', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });

      instance.on('click', 'city-roads-line', event => {
        const roadId = event.features?.[0]?.properties?.roadId;
        if (typeof roadId === 'string') propsRef.current.onSelectRoad(roadId);
      });
      instance.on('mouseenter', 'city-roads-line', () => { instance.getCanvas().style.cursor = 'pointer'; });
      instance.on('mouseleave', 'city-roads-line', () => { instance.getCanvas().style.cursor = ''; });
      syncCityMapData(instance, propsRef.current);
      setMapReady(true);
      setMapError('');
      } catch (error) {
        const detail = error instanceof Error ? error.message : '3D layer initialization failed.';
        setMapError(`3D city layers could not initialize: ${detail}`);
      }
    });
    instance.on('error', event => {
      const message = event.error?.message || 'Map tiles could not be loaded.';
      const optionalStyleResource = /glyph|font|image|sprite/i.test(message);
      if (!instance.isStyleLoaded() && !optionalStyleResource) {
        setMapError('The 3D map could not load its open building or map tiles. Check your internet connection, or switch to 2D.');
      }
    });
    };
    void initialize();
    return () => {
      disposed = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [props.location.id, props.location.latitude, props.location.longitude]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && mapReady) syncCityMapData(map, props);
  }, [props.model, props.simulation, props.radiusMeters, props.route, props.gpsPosition, props.gpsAccuracy, props.destination, props.selectedTrafficRoadIds, props.trafficRouteSelectionActive, props.layers, props.buildings, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer('satellite-imagery-background')) return;
    const satellite = props.basemap === 'satellite';
    if (satellite) {
      const currentZoom = map.getZoom();
      if (currentZoom > satelliteMaxZoom) streetZoomRef.current = currentZoom;
      map.setMaxZoom(satelliteMaxZoom);
      if (currentZoom > satelliteMaxZoom) map.easeTo({ zoom: satelliteMaxZoom, duration: 550 });
    } else {
      map.setMaxZoom(22);
      const restoreZoom = streetZoomRef.current;
      if (restoreZoom !== null) {
        streetZoomRef.current = null;
        map.easeTo({ zoom: restoreZoom, duration: 450 });
      }
    }
    map.setLayoutProperty('satellite-imagery-background', 'visibility', satellite ? 'visible' : 'none');
    const hasOpenStreetMapFootprints = Boolean(props.buildings?.features.length);
    if (map.getLayer('city-buildings-3d')) map.setLayoutProperty('city-buildings-3d', 'visibility', props.layers.Infrastructure && !hasOpenStreetMapFootprints ? 'visible' : 'none');
    if (map.getLayer('city-building-footprints-3d')) map.setLayoutProperty('city-building-footprints-3d', 'visibility', props.layers.Infrastructure && hasOpenStreetMapFootprints ? 'visible' : 'none');
    baseFillLayerIdsRef.current.forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible');
    });
  }, [props.basemap, props.layers.Infrastructure, props.buildings, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const visible = props.layers.Traffic;
    if (map.getLayer('city-roads-glow')) map.setLayoutProperty('city-roads-glow', 'visibility', visible ? 'visible' : 'none');
    if (map.getLayer('city-roads-line')) {
      map.setPaintProperty('city-roads-line', 'line-color', visible
        ? ['case', ['==', ['get', 'selected'], true], '#7658ed', ['match', ['get', 'congestion'], 'slow', '#e99f32', 'heavy', '#dc4651', 'closed', '#df3d50', '#16885f']]
        : '#71817b');
      map.setPaintProperty('city-roads-line', 'line-opacity', visible ? .96 : .48);
    }
    for (const id of ['city-road-closures', 'city-vehicle-halos', 'city-vehicles']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }, [props.layers.Traffic, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const visibility = props.layers.Incidents ? 'visible' : 'none';
    for (const id of ['city-detour-casing', 'city-detour-line', 'city-detour-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  }, [props.layers.Incidents, mapReady]);

  useEffect(() => {
    if (!props.followGps || !props.gpsPosition) return;
    mapRef.current?.easeTo({ center: toLngLat(props.gpsPosition), duration: 650 });
  }, [props.followGps, props.gpsPosition, mapReady]);

  useEffect(() => {
    if (!props.route?.coordinates.length) return;
    const points = props.route.coordinates.map(toLngLat);
    const longitudes = points.map(point => point[0]);
    const latitudes = points.map(point => point[1]);
    mapRef.current?.fitBounds([[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]], { padding: 74, maxZoom: 16, duration: 800 });
  }, [props.route, mapReady]);

  const orbit = () => {
    const nextBearing = (bearing + 42) % 360;
    setBearing(nextBearing);
    mapRef.current?.easeTo({ bearing: nextBearing, pitch, duration: 900 });
  };
  const adjustPitch = (value: number) => {
    setPitch(value);
    mapRef.current?.easeTo({ pitch: value, duration: 180 });
  };
  const roadCount = props.model?.summary.roadCount ?? 0;
  const vehicleCount = props.simulation?.metrics.activeVehicles ?? 0;
  const buildingCount = props.buildings?.features.length ?? 0;
  return <div className="maplibre-3d-view">
    <div ref={containerRef} className="maplibre-3d-canvas" aria-label={`3D map of ${props.location.name}`} />
    {panelHidden ? <button className="maplibre-3d-reopen" onClick={() => setPanelHidden(false)} aria-label="Show 3D city model controls"><Building2 size={15} /><span>3D city model</span><ChevronDown size={14} /></button> : <div className="maplibre-3d-panel">
      <div className="maplibre-3d-heading"><span className="maplibre-3d-mark"><Building2 size={15} /></span><span><b>3D CITY MODEL</b><small>{mapReady ? `${buildingCount} OSM buildings · ${roadCount} roads · ${vehicleCount.toLocaleString()} moving vehicles` : 'Loading mapped buildings and streets...'}</small></span><i className={mapReady ? 'ready' : ''} /><button className="maplibre-3d-hide" onClick={() => setPanelHidden(true)} title="Hide 3D city model controls" aria-label="Hide 3D city model controls"><ChevronUp size={15} /></button></div>
      <div className="maplibre-3d-actions"><button onClick={orbit} title="Orbit the city view"><RotateCcw size={13} /> Orbit</button><label>View angle <input type="range" min="38" max="74" value={pitch} onChange={event => adjustPitch(Number(event.target.value))} aria-label="Adjust 3D view angle" /></label></div>
      <div className="maplibre-3d-basemaps" role="group" aria-label="3D basemap"><button className={props.basemap === 'street' ? 'selected' : ''} onClick={() => props.onBasemapChange('street')}><MapIcon size={12} /> Streets</button><button className={props.basemap === 'satellite' ? 'selected' : ''} onClick={() => props.onBasemapChange('satellite')}><Satellite size={12} /> Satellite</button></div>
      <div className="maplibre-3d-hint"><span />{!props.layers.Infrastructure ? 'Turn Infrastructure on to show mapped 3D buildings' : buildingCount ? 'OSM footprints · OSM heights, estimated 3 m per tagged floor, or 6 m when unknown' : props.basemap === 'satellite' ? 'High-detail imagery · zoom up to level 19 · coverage varies by location' : 'Loading OpenStreetMap building footprints…'}</div>
    </div>}
    {mapError && <div className="maplibre-3d-error" role="status"><span>{mapError}</span><button onClick={() => props.onMap3DChange(false)}>Switch to 2D map</button></div>}
  </div>;
}

function MapFollowGps({ position, enabled }: { position: [number, number] | null; enabled: boolean }) {
  const map = useMap();
  useEffect(() => { if (enabled && position) map.panTo(position, { animate: true, duration: .4 }); }, [enabled, map, position]);
  return null;
}

function MapImageryZoom({ basemap }: { basemap: 'street' | 'satellite' }) {
  const map = useMap();
  const streetZoom = useRef<number | null>(basemap === 'satellite' ? 15 : null);
  useEffect(() => {
    const satellite = basemap === 'satellite';
    if (satellite) {
      const currentZoom = map.getZoom();
      if (currentZoom > satelliteMaxZoom) streetZoom.current = currentZoom;
      map.setMaxZoom(satelliteMaxZoom);
      if (currentZoom > satelliteMaxZoom) map.setZoom(satelliteMaxZoom, { animate: true });
    } else {
      map.setMaxZoom(19);
      if (streetZoom.current !== null) {
        map.setZoom(streetZoom.current, { animate: true });
        streetZoom.current = null;
      }
    }
  }, [basemap, map]);
  return null;
}

function MapFitRoute({ coordinates }: { coordinates: [number, number][] | null }) {
  const map = useMap();
  useEffect(() => { if (coordinates?.length) map.fitBounds(coordinates, { padding: [35, 35], maxZoom: 15, animate: true }); }, [coordinates, map]);
  return null;
}

function MapRecenter({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => { map.setView(center, 15, { animate: true }); }, [center, map]);
  return null;
}

function MapResizeObserver() {
  const map = useMap();
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false, debounceMoveend: true }));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function Metric({ icon, label, value, unit, delta, tone, foot }: { icon: React.ReactNode; label: string; value: string; unit: string; delta: React.ReactNode; tone: string; foot: string }) {
  return <div className="metric-card"><div className="metric-top"><span className={`metric-icon ${tone}`}>{icon}</span><span className={`metric-change ${tone}`}>{delta}</span></div><div className="metric-value">{value}<small>{unit}</small></div><div className="metric-label">{label}</div><div className="metric-foot">{foot}</div></div>;
}

function PreviewMapZoom({ factor }: { factor: number }) {
  const map = useMap();
  useEffect(() => { map.setZoom(12 + Math.round((factor - 1) * 10)); }, [factor, map]);
  return null;
}

function TwinMap({ hasLocation, zoom }: { hasLocation: boolean; zoom: number }) {
  if (hasLocation) return null;
  return <div className="default-map-preview" aria-label="OpenStreetMap preview">
    <MapContainer center={[26.9124, 75.7874]} zoom={12} scrollWheelZoom className="leaflet-map">
      <TileLayer attribution={'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'} url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
      <PreviewMapZoom factor={zoom} />
      <MapResizeObserver />
    </MapContainer>
    <div className="map-preview-prompt"><span><MapPin size={16} /></span><div><b>Start with a real location</b><small>Search a place to load its OpenStreetMap roads and current weather.</small></div></div>
    <div className="map-preview-credit">OpenStreetMap preview | no location selected</div>
  </div>;
}

export default App;

