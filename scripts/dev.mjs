import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envFile = resolve(projectRoot, '.env.local');
try {
  const text = await (await import('node:fs/promises')).readFile(envFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
} catch { /* A local env file is optional. */ }

async function isPortAvailable(port) {
  const probe = createServer();
  return new Promise(resolveAvailable => {
    probe.once('error', () => resolveAvailable(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveAvailable(true)));
  });
}

async function findFreePort() {
  const probe = createServer();
  return new Promise((resolvePort, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

function isUrbanTwinApi(health) {
  const features = health?.features;
  const requiredFeatures = [
    'sumo-micro-simulation-v1',
    'road-thresholds-v1',
    'immediate-manual-road-thresholds-v1',
    'network-average-vehicle-range-v1',
    'closure-countdown-units-v1',
  ];
  return health?.service === 'urban-twin-api'
    && Array.isArray(features)
    && requiredFeatures.every(feature => features.includes(feature))
    && features.some(feature => /^open-meteo-current-weather-v\d+$/.test(feature));
}

async function waitForBackend(port, hasExited, getFailure) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (hasExited()) throw new Error(getFailure() || 'The API process stopped before it became ready.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(900) });
      const health = response.ok ? await response.json() : null;
      if (isUrbanTwinApi(health)) return;
    } catch { /* The API is still starting. Retry until it is ready or times out. */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error(`The API did not become ready on port ${port} within 12 seconds.`);
}

let backend;
let ownsBackend = false;
let apiPort = Number(process.env.API_PORT || 8000);
let reuseBackend = false;
try {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(1200) });
  const health = response.ok ? await response.json() : null;
  if (isUrbanTwinApi(health)) {
    console.log(`Using the current Rutora API on port ${apiPort}.`);
    reuseBackend = true;
  } else {
    const oldPort = apiPort;
    apiPort = await findFreePort();
    console.warn(`Port ${oldPort} has an older or different API. Starting this project API on port ${apiPort}.`);
  }
} catch {
  if (!(await isPortAvailable(apiPort))) {
    const oldPort = apiPort;
    apiPort = await findFreePort();
    console.warn(`Port ${oldPort} is already in use. Starting this project API on port ${apiPort}.`);
  }
}
process.env.API_PORT = String(apiPort);
if (!reuseBackend) {
  backend = spawn(process.execPath, ['backend/server.mjs'], { cwd: projectRoot, stdio: 'inherit', env: process.env });
  ownsBackend = true;
  let backendExited = false;
  let backendFailure = '';
  backend.once('error', error => { backendExited = true; backendFailure = `Could not start the API: ${error.message}`; });
  backend.once('exit', code => { backendExited = true; if (code !== 0) backendFailure = `The API process exited with code ${code ?? 'unknown'}.`; });
  try {
    await waitForBackend(apiPort, () => backendExited, () => backendFailure);
  } catch (error) {
    backend.kill();
    console.error(error instanceof Error ? error.message : 'The API failed to start.');
    process.exit(1);
  }
}
const viteCli = resolve(projectRoot, 'node_modules/vite/bin/vite.js');
const web = spawn(process.execPath, [viteCli, '--host', '127.0.0.1'], { cwd: projectRoot, stdio: 'inherit', env: process.env });

let shuttingDown = false;
function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (ownsBackend && backend && !backend.killed) backend.kill();
  if (!web.killed) web.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
backend?.on('exit', code => {
  if (shuttingDown) return;
  console.error(`The API stopped unexpectedly${code === null ? '' : ` with code ${code}`}.`);
  stop();
  process.exit(code ?? 1);
});
backend?.on('error', error => {
  if (shuttingDown) return;
  console.error('Could not start the API:', error.message);
  stop();
  process.exit(1);
});
web.on('exit', code => {
  if (shuttingDown) return;
  stop();
  if (code && code !== 0) process.exit(code);
});
