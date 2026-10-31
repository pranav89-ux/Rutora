# AI-Powered Urban Digital Twin

A local planning and demonstration application that builds a road network from OpenStreetMap and runs vehicle microsimulation with SUMO. It also shows public weather-model data, mapped driving directions, and route alternatives around temporary road closures.

## Run locally

Requires Node.js 20 or newer, Python, and the project-local SUMO runtime.

```powershell
npm install
py -m venv .venv-sumo
.\.venv-sumo\Scripts\python.exe -m pip install eclipse-sumo==1.28.0 traci==1.28.0 sumolib==1.28.0
Copy-Item .env.example .env.local
npm run dev
```

Open the URL printed by Vite. The launcher starts the local API and Vite and waits for the API health check before starting the frontend. `npm run vite-only` starts only the frontend; API-backed features require the API to be running separately. `npm run backend` starts only the API. `npm run build` creates a production frontend build.

The `.venv-sumo` folder contains the local SUMO installation and is ignored by Git. If SUMO is missing, the app reports that the engine is unavailable rather than displaying fabricated simulation output. Restart `npm run dev` after changing environment settings.

## Features

- Search for a place and display its real OpenStreetMap road network on street or Esri satellite tiles.
- Convert the selected OSM road graph into a SUMO network and run IDM car-following with LC2013 lane changing.
- Set vehicle departures per hour, simulation speed, and per-road amber/red thresholds.
- Close a mapped road while SUMO is running. The engine restricts vehicle access on that segment and reroutes vehicles where a connected alternative exists.
- View before/after SUMO snapshots and ranked road-network detours, including estimated ETA, distance, modeled congestion, access restrictions, one-way direction, and mapped OSM hazard tags.
- Search a destination, request OSRM driving routes, inspect directions, and use browser GPS follow mode.
- View current Open-Meteo weather-model values for the selected location.
- Choose dark, light, or system appearance and change the interface font and text scale in Settings.

## How traffic output is produced

Road geometry, road class, mapped speed limit, lane count, access tags, one-way direction, and available surface/hazard tags come from OpenStreetMap through Overpass. The backend converts the selected network into SUMO node and edge files with `netconvert`.

SUMO creates simulated trips from a configured departure rate. It selects connected origin/destination pairs from the mapped road graph and advances vehicles using the IDM car-following model and LC2013 lane-change model. Vehicle positions, speeds, arrivals, and road occupancy come from TraCI snapshots. Road closures change passenger-vehicle access in SUMO and ask vehicles to recalculate their routes.

The application does **not** connect to roadside sensors, mobile-device traces, or a live traffic provider. Vehicles, speed, congestion, and closure impacts are simulation outputs, not observed counts. The configured departure rate is an assumption for the model, not a measured local traffic volume. SUMO makes the movement and interactions more realistic than fixed/random dots, but it does not make the scenario a calibrated forecast without local demand, signal plans, fleet mix, and validation data.

The route comparison is a network estimate: it uses OSM speed limits when present, otherwise road-class speed defaults, and SUMO road speed samples when vehicles are present on a segment. With current Overpass data, it applies mapped access and one-way restrictions and uses mapped hazard tags in the route ranking. If Overpass is unavailable, the app can reuse a saved OSM geometry snapshot and labels it with its save date. Older snapshots may not contain access or hazard tags; in that case the comparison marks those constraints as unavailable and ranks only by its available time/congestion estimate. No OSM hazard tag is not proof that a road is safe. Route ETA and hazard penalties are planning estimates and are not the same as SUMO vehicle travel-time measurements or live incident data.

Open-Meteo supplies current forecast-model values. When a simulation is initialized, current precipitation can reduce the configured vehicle speed factor. Weather values are model data rather than readings from a local weather station.

## Public services and APIs used

| Service or API | Use | Data limits |
| --- | --- | --- |
| OpenStreetMap / Overpass API | Road geometry, names, road class, speed/access tags, and OSM hazard/surface tags | Open map data under ODbL. Coverage varies; public Overpass servers can be busy. |
| OpenStreetMap raster tiles | Street basemap | Public tile host is best-effort; keep visible attribution and avoid bulk tile requests. |
| Esri World Imagery | Satellite basemap | Coverage, resolution, and capture date vary by location. Attribution and provider terms apply. |
| Open-Meteo Geocoding API | Location and destination search | No API key used in this local PBL setup; location results are based on GeoNames. |
| Open-Meteo Forecast API | Current weather-model values | Public service and model data; this is not a station observation or live radar feed. |
| OSRM HTTP API | Driving route geometry, ETA, distance, and maneuver steps | Public endpoint is best-effort and does not provide live traffic-aware travel time. |
| SUMO, TraCI, and netconvert | Local microscopic traffic simulation, engine control, and OSM road-network conversion | Runs locally; no external traffic feed is included. |
| Browser Geolocation API | GPS position and navigation follow | Requires user permission and a secure context (`localhost` or HTTPS); location stays in the browser. |

## If a public service is blocked or unavailable

1. **Map tiles:** Set `VITE_STREET_TILE_URL` or `VITE_SATELLITE_TILE_URL` in `.env.local` to another XYZ-compatible tile URL, and set `VITE_SATELLITE_ATTRIBUTION` to that provider's required credit.
2. **Road geometry:** Set `OVERPASS_URL` to another Overpass-compatible `/api/interpreter` endpoint. The model builder expects road ways with geometry and tags.
3. **Place search and weather:** Set `GEOCODING_URL` or `WEATHER_URL` to a compatible Open-Meteo endpoint. If another provider uses a different response schema, adapt the handlers in `backend/server.mjs`.
4. **Driving routes:** A self-hosted OSRM instance can be selected by setting `ROUTING_URL` to its base URL. Follow the [OSRM Docker quick start](https://github.com/Project-OSRM/osrm-backend#using-docker) and run it on port 5000, then set `$env:ROUTING_URL = 'http://127.0.0.1:5000'` before `npm run dev`.
5. **SUMO:** Recreate `.venv-sumo` with the install commands above. To use a different Python executable, set `SUMO_PYTHON` before starting the backend.
6. **GPS permission:** Allow location access in browser site settings. Use `http://localhost` for local development or deploy over HTTPS.

### Environment variables

Copy `.env.example` to `.env.local` and adjust values as needed. For example:

```powershell
$env:ROUTING_URL = 'http://127.0.0.1:5000'
npm run dev
```

`API_PORT`, `ROUTING_URL`, `OVERPASS_URL`, `GEOCODING_URL`, and `WEATHER_URL` are backend configuration. `SUMO_PYTHON` can point to a custom Python runtime with SUMO, TraCI, and sumolib installed. `VITE_STREET_TILE_URL`, `VITE_SATELLITE_TILE_URL`, and `VITE_SATELLITE_ATTRIBUTION` are frontend configuration and must not contain secrets.

## Source documents

- Slide-by-slide text extraction: [docs/presentation-extract.md](docs/presentation-extract.md)
- The original presentation image is preserved under `public/source-assets/`.
