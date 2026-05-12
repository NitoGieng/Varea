import ReactPlot from 'react-plotly.js';
import { useTranslation } from 'react-i18next';
import { parseBackendTimestamp } from '../../utils/time';

// react-plotly.js non fornisce tipi ufficiali stabili: il cast a any permette
// l'accesso a .default in ambienti che lo wrappano (Vite SSR/CJS interop).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = (ReactPlot as any).default || ReactPlot;

// Orario assoluto HH:MM:SS nel fuso del browser (= fuso di regata per chi
// rivede sessioni sul proprio device). Se il timestamp manca o e' invalido
// torna stringa vuota: il chiamante decide come gestire l'assenza.
function formatLocalClock(ts: string | undefined): string {
  if (!ts) return '';
  const ms = parseBackendTimestamp(ts);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

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

// Marker numerato di una nota allenatore. La conversione timestamp→lat/lon
// avviene nel chiamante (Dashboard), che ha accesso al highResTrack per
// risolvere la posizione geografica del momento annotato.
export interface NoteMarker {
  id: string;
  lat: number;
  lon: number;
  number: number;
  color: string;
}

interface Props {
  layers: MapLayer[];
  // 'speed': heatmap Plasma per-SOG (modalita' storica single-session).
  // 'session': un polyline colorato per atleta, nessuna colorbar.
  colorMode: 'speed' | 'session';
  // Budget totale di punti renderizzati, distribuito proporzionalmente tra i
  // layer. Difende il DOM/WebGL quando si confrontano piu' atleti su sessioni lunghe.
  maxPoints?: number;
  // Marker delle note: renderizzati come trace separato sopra il tracciato.
  // Solo in modalita' speed (single session). Vuoto = nessuna nota.
  noteMarkers?: NoteMarker[];
  highlightedNoteId?: string | null;
  // Click su un punto del tracciato (markers heatmap in modalita' speed):
  // il chiamante apre il popup di nuova nota. timestamp = stringa ISO del
  // punto piu' vicino (quella decimata, gia' nel layer points).
  // pixelX/pixelY = coordinate finestra browser, da rimappare al
  // container relative dal chiamante.
  onTrackClick?: (timestamp: string, pixelX: number, pixelY: number) => void;
  // Click su un marker di nota: avvia il flusso di modifica.
  onNoteMarkerClick?: (id: string, pixelX: number, pixelY: number) => void;
}

const NOTE_MARKER_COLOR = '#c9a169';

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
  noteMarkers,
  highlightedNoteId,
  onTrackClick,
  onNoteMarkerClick,
}: Props) {
  const { t } = useTranslation();
  // Il backend emette andature in italiano ('Bolina', 'Traverso', 'Lasco/Poppa').
  // Per il tooltip mappiamo al label tradotto via chiavi polarChart, cosi'
  // l'EN vede 'Upwind/Reach/Downwind' senza toccare il pipeline analitico.
  const ANDATURA_LABEL_KEY: Record<string, string> = {
    Bolina: 'polarChart.groupBolina',
    Traverso: 'polarChart.groupTraverso',
    'Lasco/Poppa': 'polarChart.groupLascoPoppa',
  };
  const translateAndatura = (raw: string | null | undefined): string => {
    if (!raw) return t('common.na');
    const key = ANDATURA_LABEL_KEY[raw];
    return key ? t(key) : t('polarChart.groupOther');
  };
  const visibleLayers = layers.filter(l => l.points.length > 0);

  if (visibleLayers.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-ink-muted text-caption italic">
        {t('map.noGpsData')}
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
    // Ordine voci hover: ORARIO assoluto in cima per dare contesto temporale
    // immediato (l'allenatore correla con la timeline mentale della regata),
    // seguito da SOG/TWA/andatura. Se il punto manca di timestamp, l'orario
    // viene omesso invece di mostrare "—" che sarebbe confondente.
    const hoverTime = t('map.hoverTime');
    const hoverSpeed = t('map.hoverSpeed');
    const hoverSail = t('map.hoverSail');
    const hoverTexts = pts.map(p => {
      const clock = formatLocalClock(p.timestamp);
      const head = clock ? `${hoverTime}: ${clock}<br>` : '';
      return `${head}${hoverSpeed}: ${p.sog_knots.toFixed(1)} kts<br>TWA: ${(p.twa ?? 0).toFixed(0)}°<br>${hoverSail}: ${translateAndatura(p.andatura)}`;
    });

    // Trace base (line + markers heatmap + START + FINE). Indici fissi
    // 0,1,2,3: usati per dispatchare l'onClick.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [
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
            title: { text: t('map.colorbarSog'), font: { family: 'Inter, sans-serif', size: 10, color: '#a8b3c4' } },
            thickness: 12, len: 0.7, outlinewidth: 0,
            tickfont: { family: 'JetBrains Mono, ui-monospace, monospace', size: 10, color: '#a8b3c4' },
          },
        },
        text: hoverTexts, hoverinfo: 'text', showlegend: false,
      },
      {
        type: 'scattermap', lat: [lats[0]], lon: [lons[0]], mode: 'markers+text',
        marker: { size: 12, color: '#7fa885' },
        text: [t('map.startMarker')], textposition: 'top right',
        textfont: { family: 'JetBrains Mono, monospace', size: 11, color: '#7fa885' },
        hovertext: [t('map.startHover')], hoverinfo: 'text', showlegend: false,
      },
      {
        type: 'scattermap', lat: [lats[lats.length - 1]], lon: [lons[lons.length - 1]], mode: 'markers+text',
        marker: { size: 12, color: '#c97462' },
        text: [t('map.endMarker')], textposition: 'top right',
        textfont: { family: 'JetBrains Mono, monospace', size: 11, color: '#c97462' },
        hovertext: [t('map.endHover')], hoverinfo: 'text', showlegend: false,
      },
    ];

    // Trace 4 (opzionale): note allenatore. Marker numerati gold con
    // hover text che anticipa il numero della nota. Plotly non supporta
    // testo dentro al marker direttamente, quindi sovrapponiamo testo
    // (textposition='middle center') sopra al marker nello stesso trace.
    const noteTraceIdx = traces.length;
    if (noteMarkers && noteMarkers.length > 0) {
      const nLats = noteMarkers.map(n => n.lat);
      const nLons = noteMarkers.map(n => n.lon);
      const nLabels = noteMarkers.map(n => String(n.number));
      const nHover = noteMarkers.map(n => t('map.noteHover', { number: n.number }));
      const nColors = noteMarkers.map(n => n.color || NOTE_MARKER_COLOR);
      const nSizes = noteMarkers.map(n => n.id === highlightedNoteId ? 22 : 18);
      traces.push({
        type: 'scattermap',
        lat: nLats, lon: nLons,
        mode: 'markers+text',
        marker: {
          size: nSizes,
          color: nColors,
          opacity: 1,
        },
        text: nLabels,
        textposition: 'middle center',
        textfont: { family: 'JetBrains Mono, monospace', size: 11, color: '#0a1428' },
        hovertext: nHover, hoverinfo: 'text',
        showlegend: false,
      });
    }

    // Dispatch click in base al curveNumber: trace 1 = markers heatmap,
    // noteTraceIdx = note. Coordinate pixel da event per ancorare il
    // popup nel chiamante (rimapping a relative-container fa lui).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleMapClick = (e: any) => {
      const point = e?.points?.[0];
      if (!point) return;
      const curve = point.curveNumber;
      const idx = point.pointNumber;
      // event.event.clientX/Y sono assoluti rispetto alla finestra: il
      // chiamante li sottrae al boundingClientRect del proprio container
      // per ottenere coordinate locali.
      const clientX = e?.event?.clientX ?? 0;
      const clientY = e?.event?.clientY ?? 0;
      if (curve === 1 && onTrackClick) {
        const p = pts[idx];
        if (p && p.timestamp) onTrackClick(p.timestamp, clientX, clientY);
      } else if (curve === noteTraceIdx && noteMarkers && onNoteMarkerClick) {
        const m = noteMarkers[idx];
        if (m) onNoteMarkerClick(m.id, clientX, clientY);
      }
    };

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
          onClick={handleMapClick}
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
    const hoverTime = t('map.hoverTime');
    const hoverSail = t('map.hoverSail');
    const hoverTexts = l.points.map(p => {
      const clock = formatLocalClock(p.timestamp);
      const head = clock ? `${hoverTime}: ${clock}<br>` : '';
      return `${head}${l.label}<br>SOG: ${p.sog_knots.toFixed(1)} kts`
        + (p.twa != null ? `<br>TWA: ${p.twa.toFixed(0)}°` : '')
        + (p.andatura ? `<br>${hoverSail}: ${translateAndatura(p.andatura)}` : '');
    });
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
