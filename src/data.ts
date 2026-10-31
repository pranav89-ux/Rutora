/** Incident reports are intentionally empty until a verified reporting source is connected. */
export type Incident = {
  id: number;
  title: string;
  type: string;
  place: string;
  severity: 'High' | 'Medium' | 'Low';
  time: string;
  x: number;
  y: number;
};

export const incidents: Incident[] = [];

/** Integration references, not claims that live sensors or feeds are connected. */
export const sources = [
  { label: 'Road geometry', detail: 'OpenStreetMap via Overpass · loaded on location search', status: 'configured' },
  { label: 'Traffic engine', detail: 'Local SUMO / TraCI microsimulation', status: 'local' },
  { label: 'Current weather', detail: 'Open-Meteo forecast model · location required', status: 'configured' },
  { label: 'Driving routes', detail: 'OSRM public routing endpoint · best effort', status: 'configured' },
];
