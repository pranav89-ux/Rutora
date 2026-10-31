import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const python = process.env.SUMO_PYTHON || resolve(projectRoot, '.venv-sumo', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const sumoHome = process.env.SUMO_HOME || (process.platform === 'win32' ? resolve(projectRoot, '.venv-sumo', 'Lib', 'site-packages', 'sumo') : null);
const workerScript = resolve(here, 'sumo-worker.py');
const sessions = new Map();
let cachedStatus;

function checkInstallation() {
  if (cachedStatus) return cachedStatus;
  if (!existsSync(python)) {
    cachedStatus = { available: false, engine: 'SUMO', reason: 'SUMO Python runtime is not installed. Follow the SUMO setup steps in README.md.' };
    return cachedStatus;
  }
  const probe = spawnSync(python, ['-c', 'import importlib.metadata as m, traci, sumolib; print(m.version("eclipse-sumo"))'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  cachedStatus = probe.status === 0
    ? { available: true, engine: 'SUMO / TraCI', version: probe.stdout.trim() || 'installed' }
    : { available: false, engine: 'SUMO', reason: 'SUMO was found but its Python packages are incomplete. Install eclipse-sumo, traci, and sumolib in the project virtual environment.' };
  return cachedStatus;
}

function startWorker(simulationId) {
  const installation = checkInstallation();
  if (!installation.available) throw new Error(installation.reason);
  const child = spawn(python, [workerScript], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(sumoHome ? { SUMO_HOME: sumoHome } : {}) },
  });
  const pending = new Map();
  let output = '';
  let errorOutput = '';
  const session = { child, pending, request: null, errorOutput };
  sessions.set(simulationId, session);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const request = pending.get(response.requestId);
    if (!request) return;
    pending.delete(response.requestId);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error || 'SUMO simulation failed.'));
  });
  child.stderr.on('data', chunk => {
    errorOutput += chunk.toString();
    if (errorOutput.length > 8000) errorOutput = errorOutput.slice(-8000);
  });
  child.on('error', error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    sessions.delete(simulationId);
  });
  child.on('exit', (code, signal) => {
    const detail = errorOutput.trim().split(/\r?\n/).at(-1);
    const error = new Error(detail || `SUMO worker stopped (${code ?? signal ?? 'unknown'}).`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    sessions.delete(simulationId);
  });
  session.request = (action, payload = {}) => new Promise((resolveRequest, rejectRequest) => {
    if (child.killed || child.exitCode !== null) return rejectRequest(new Error('SUMO worker is not running.'));
    const requestId = randomUUID();
    pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest });
    child.stdin.write(`${JSON.stringify({ ...payload, action, requestId })}\n`, error => {
      if (error) {
        pending.delete(requestId);
        rejectRequest(error);
      }
    });
  });
  return session;
}

export function sumoStatus() {
  return checkInstallation();
}

export async function startSumoSimulation(simulation) {
  const oldSession = sessions.get(simulation.id);
  if (oldSession) await stopSumoSimulation(simulation.id);
  const session = startWorker(simulation.id);
  try {
    return await session.request('init', {
      id: simulation.id,
      model: simulation.model,
      trafficVolume: simulation.trafficVolume,
      rainMmH: simulation.rainMmH || 0,
    });
  } catch (error) {
    session.child.kill();
    sessions.delete(simulation.id);
    throw error;
  }
}

export async function commandSumoSimulation(id, action, payload = {}) {
  const session = sessions.get(id);
  if (!session) throw new Error('SUMO simulation worker is not running. Recreate the simulation to restore its state.');
  return session.request(action, payload);
}

export async function stopSumoSimulation(id) {
  const session = sessions.get(id);
  if (!session) return;
  try { await session.request('close'); } catch { /* The SUMO process may already have exited. */ }
  session.child.kill();
  sessions.delete(id);
}

export async function stopAllSumoSimulations() {
  await Promise.all([...sessions.keys()].map(stopSumoSimulation));
}
