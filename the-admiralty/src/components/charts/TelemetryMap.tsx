import ReactPlot from 'react-plotly.js';

// react-plotly.js non fornisce tipi ufficiali stabili: il cast a any permette
// l'accesso a .default in ambienti che lo wrappano (Vite SSR/CJS interop).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = (ReactPlot as any).default || ReactPlot;

// Punto minimo che la mappa sa consumare. Le proprieta' opzionali arricchiscono
// il tooltip quando disponibili ma non sono richieste.
export interface MapPoint {
  lat: number;
  lon: number;
  sog_knots: number;
  twa?: number;
  andatura?: string;
  timestamp?: string;
}

export interface MapLayer {
  id: string;
  label: string;
  color: string;
  points: MapPoint[];
}

interface Props {
  layers: MapLayer[];
  // 'speed': heatmap Plasma per-SOG (modalita' storica single-session).
  // 'session': un polyline colorato per atleta, nessuna colorbar.
  colorMode: 'speed' | 'session';
  // Budget totale di punti renderizzati, distribuito proporzionalmente tra i
  // layer. Difende il DOM/WebGL quando si confrontano piu' atleti su sessioni lunghe.
  maxPoints?: number;
}

const DEFAULT_MAX_POINTS = 1200;
const MIN_POINTS_PER_LAYER = 50;

// Decimazione con stride uniforme. Ultimo punto forzato per chiudere il tracciato
// anche quando la divisione intera scarta la coda.
function decimate<T>(points: T[], targetCount: number): T[] {
  if (points.length <= targetCount) return points;
  const stride = Math.ceil(points.length / targetCount);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

// Ogni layer riceve maxPoints * |suoi| / |totale|, con floor a MIN_POINTS_PER_LAYER
// per evitare che sessioni brevi spariscano dalla decimazione proporzionale.
function decimateLayers(layers: MapLayer[], maxPoints: number): MapLayer[] {
  const total = layers.reduce((a, l) => a + l.points.length, 0);
  if (total === 0 || total <= maxPoints) return layers;
  return layers.map(l => {
    const share = Math.floor((maxPoints * l.points.length) / total);
    const budget = Math.max(MIN_POINTS_PER_LAYER, share);
    return { ...l, points: decimate(l.points, budget) };
  });
}

export default function TelemetryMap({
  layers,
  colorMode,
  maxPoints = DEFAULT_MAX_POINTS,
}: Props) {
  const visibleLayers = layers.filter(l => l.points.length > 0);

  if (visibleLayers.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-ink-muted text-caption italic">
        Nessun dato GPS da mostrare
      </div>
    );
  }

  const decimated = decimateLayers(visibleLayers, maxPoints);

  // Centroide su tutti i layer: baricentro robusto anche con atleti in zone
  // vicine ma non coincidenti (evita di centrare solo sul primo).
  let sumLat = 0, sumLon = 0, count = 0;
  for (const l of decimated) {
    for (const p of l.points) { sumLat += p.lat; sumLon += p.lon; count++; }
  }
  const avgLat = sumLat / count;
  const avgLon = sumLon / count;

  // --- MODALITA' VELOCITA' (single-session): heatmap SOG con START/FINE ---
  if (colorMode === 'speed' && decimated.length === 1) {
    const pts = decimated[0].points;
    const lats = pts.map(p => p.lat);
    const lons = pts.map(p => p.lon);
    const speeds = pts.map(p => p.sog_knots);
    const hoverTexts = pts.map(p =>
      `Speed: ${p.sog_knots.toFixed(1)} kts<br>TWA: ${(p.twa ?? 0).toFixed(0)}°<br>Sail: ${p.andatura ?? '—'}`
    );
    return (
      <div className="absolute inset-0 w-full h-full z-0">
        <Plot
          data={[
            {
              type: 'scattermap', lat: lats, lon: lons, mode: 'lines',
              line: { width: 1.5, color: 'rgba(201, 161, 105, 0.45)' },
              hoverinfo: 'skip', showlegend: false,
            },
            {
              type: 'scattermap', lat: lats, lon: lons, mode: 'markers',
              marker: {
                size: 5, color: speeds, showscale: true,
                // Colorscale brand-aligned: sage (SOG bassa) → brass → avorio
                // (SOG alta). Nessun estremo scuro: tutti i valori restano
                // leggibili sia su carto-darkmatter che su carto-positron.
                colorscale: [
                  [0, '#4a7a58'],
                  [0.35, '#c9a169'],
                  [0.7, '#e8cea0'],
                  [1, '#f5f1e6'],
                ],
                colorbar: {
                  title: { text: 'SOG (kts)', font: { family: 'Inter, sans-serif', size: 10, color: '#a8b3c4' } },
                  thickness: 12, len: 0.7, outlinewidth: 0,
                  tickfont: { family: 'JetBrains Mono, ui-monospace, monospace', size: 10, color: '#a8b3c4' },
                },
              },
              text: hoverTexts, hoverinfo: 'text', showlegend: false,
            },
            {
              type: 'scattermap', lat: [lats[0]], lon: [lons[0]], mode: 'markers+text',
              marker: { size: 12, color: '#7fa885' },
              text: ['START'], textposition: 'top right',
              textfont: { family: 'JetBrains Mono, monospace', size: 11, color: '#7fa885' },
              hovertext: ['Inizio tracciato'], hoverinfo: 'text', showlegend: false,
            },
            {
              type: 'scattermap', lat: [lats[lats.length - 1]], lon: [lons[lons.length - 1]], mode: 'markers+text',
              marker: { size: 12, color: '#c97462' },
              text: ['FINE'], textposition: 'top right',
              textfont: { family: 'JetBrains Mono, monospace', size: 11, color: '#c97462' },
              hovertext: ['Fine tracciato'], hoverinfo: 'text', showlegend: false,
            },
          ]}
          layout={{
            dragmode: 'pan',
            margin: { l: 0, r: 0, t: 0, b: 0 },
            map: {
              style: 'carto-darkmatter',
              center: { lat: avgLat, lon: avgLon },
              zoom: 13, layers: [], uirevision: 'true',
            },
            autosize: true, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
          }}
          config={{ scrollZoom: true, displayModeBar: false }}
          useResizeHandler={true}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    );
  }

  // --- MODALITA' SESSIONE (multi-atleta): polyline colorato per atleta ---
  // Il colore identifica l'atleta, non la velocita'. Ogni layer = traccia linea
  // + marker al primo punto con la label dell'atleta. Niente FINE marker per
  // ridurre il rumore visivo quando ci sono N tracce sovrapposte.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traces: any[] = [];
  for (const l of decimated) {
    const lats = l.points.map(p => p.lat);
    const lons = l.points.map(p => p.lon);
    const hoverTexts = l.points.map(p =>
      `${l.label}<br>SOG: ${p.sog_knots.toFixed(1)} kts`
      + (p.twa != null ? `<br>TWA: ${p.twa.toFixed(0)}°` : '')
      + (p.andatura ? `<br>Sail: ${p.andatura}` : '')
    );
    traces.push({
      type: 'scattermap', lat: lats, lon: lons, mode: 'lines',
      line: { width: 2, color: l.color },
      text: hoverTexts, hoverinfo: 'text',
      name: l.label, showlegend: false,
    });
    traces.push({
      type: 'scattermap', lat: [lats[0]], lon: [lons[0]], mode: 'markers+text',
      marker: { size: 10, color: l.color },
      text: [l.label], textposition: 'top right',
      textfont: { family: 'JetBrains Mono, monospace', size: 11, color: l.color },
      hoverinfo: 'skip', showlegend: false,
    });
  }

  return (
    <div className="absolute inset-0 w-full h-full z-0">
      <Plot
        data={traces}
        layout={{
          dragmode: 'pan',
          margin: { l: 0, r: 0, t: 0, b: 0 },
          map: {
            style: 'carto-darkmatter',
            center: { lat: avgLat, lon: avgLon },
            zoom: 13, layers: [], uirevision: 'true',
          },
          autosize: true, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
        }}
        config={{ scrollZoom: true, displayModeBar: false }}
        useResizeHandler={true}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
