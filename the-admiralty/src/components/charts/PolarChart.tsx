import { useMemo } from 'react';
import ReactPlot from 'react-plotly.js';
import type {
  PolarBucket,
  PolarValidPoint,
} from '../../utils/polar';

// react-plotly.js wrapping coerente con TelemetryMap.tsx: stesso bug Vite/CJS
// interop sul .default, stesso cast. Tenere allineato se uno dei due cambia.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = (ReactPlot as any).default || ReactPlot;

interface Props {
  rawPoints: PolarValidPoint[];
  buckets: PolarBucket[];
  smoothedP90: (number | null)[];
  maxSog: number;
}

// Colori per andatura allineati ai token cockpit. Riproduzione hex/rgb
// invece di var(--name) perche' Plotly traccia i marker in canvas/SVG
// senza accesso al CSSOM: var() non viene risolto.
const ANDATURA_COLOR: Record<string, string> = {
  Bolina: 'rgb(138,156,209)',     // var(--violet)
  Traverso: 'rgb(111,207,209)',   // var(--cyan)
  'Lasco/Poppa': 'rgb(212,175,110)', // var(--gold)
};
const FALLBACK_COLOR = 'rgb(170,184,204)'; // var(--ink-2)
const INK_3 = 'rgb(107,125,150)'; // var(--ink-3)
const GOLD = 'rgb(212,175,110)';

// Layer 1 — scatter dei punti grezzi. Per la simmetria (stesso punto a
// sinistra e destra del verticale) duplichiamo ogni campione su theta e
// 360-theta. Plotly Scatterpolar accetta entrambi senza ulteriore logica.
function buildScatterTrace(points: PolarValidPoint[], andatura: string, color: string) {
  const r: number[] = [];
  const theta: number[] = [];
  const text: string[] = [];
  for (const p of points) {
    r.push(p.sog);
    theta.push(p.twa);
    text.push(`TWA ${p.twa.toFixed(0)}° • ${p.sog.toFixed(1)} kts`);
    r.push(p.sog);
    theta.push((360 - p.twa) % 360);
    text.push(`TWA ${p.twa.toFixed(0)}° • ${p.sog.toFixed(1)} kts`);
  }
  return {
    type: 'scatterpolar',
    mode: 'markers',
    name: andatura || 'Dati sessione',
    r,
    theta,
    text,
    hoverinfo: 'text',
    marker: {
      size: 3,
      color,
      opacity: 0.25,
      line: { width: 0 },
    },
    showlegend: !!andatura,
    legendgroup: 'raw',
  };
}

// Costruisce una curva continua sul giro intero a partire da 36 bucket
// 0-180°: percorre i bucket validi 0->180 sul semicerchio destro, poi
// rimbalza da 180->0 sul sinistro come specchio (theta = 360 - center).
// I gap (bucket null) interrompono la linea con NaN — Plotly stacca il
// segmento invece di chiuderlo a tagliando il vuoto.
function buildCurveTrace(
  buckets: PolarBucket[],
  values: (number | null)[],
  color: string,
  width: number,
  name: string,
  fill?: boolean,
) {
  const r: (number | null)[] = [];
  const theta: number[] = [];
  // Lato destro: 0° -> 180° (theta crescente)
  for (let i = 0; i < buckets.length; i++) {
    r.push(values[i]);
    theta.push(buckets[i].centerDeg);
  }
  // Lato sinistro speculare: rispecchia in ordine inverso, cosi' la
  // linea si chiude attorno alla poppa (180°) e torna in cima (360°).
  for (let i = buckets.length - 1; i >= 0; i--) {
    r.push(values[i]);
    theta.push(360 - buckets[i].centerDeg);
  }
  // Chiudi il loop riprendendo il primo punto (specchiato a 360°).
  if (values[0] != null) {
    r.push(values[0]);
    theta.push(360);
  }

  const trace: Record<string, unknown> = {
    type: 'scatterpolar',
    mode: 'lines',
    name,
    r,
    theta,
    line: { color, width, shape: 'spline', smoothing: 0.5 },
    hoverinfo: 'r+theta+name',
    connectgaps: false,
    legendgroup: name,
  };
  if (fill) {
    trace.fill = 'toself';
    trace.fillcolor = 'rgba(212,175,110,0.08)';
  }
  return trace;
}

export default function PolarChart({ rawPoints, buckets, smoothedP90, maxSog }: Props) {
  const data = useMemo(() => {
    // Raggruppo lo scatter per andatura cosi' la legenda e' utile (un
    // entry per categoria invece di un blob unico). Le andature non
    // riconosciute finiscono nel gruppo "Altro" col fallback color.
    const groups: Record<string, PolarValidPoint[]> = {};
    for (const p of rawPoints) {
      const key = ANDATURA_COLOR[p.andatura] ? p.andatura : 'Altro';
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    }

    const traces: unknown[] = [];
    // Ordine di disegno: scatter sotto, media in mezzo, P90 sopra (priorita'
    // visiva). La legenda di Plotly riflette l'ordine di insert.
    for (const key of Object.keys(groups)) {
      const color = ANDATURA_COLOR[key] ?? FALLBACK_COLOR;
      traces.push(buildScatterTrace(groups[key], key, color));
    }

    const avgValues = buckets.map(b => b.sogAvg);
    traces.push(buildCurveTrace(buckets, avgValues, INK_3, 1, 'Media'));
    traces.push(buildCurveTrace(buckets, smoothedP90, GOLD, 2.5, 'Performance (P90)', true));

    return traces;
  }, [rawPoints, buckets, smoothedP90]);

  const layout = useMemo(() => ({
    polar: {
      radialaxis: {
        visible: true,
        range: [0, Math.max(maxSog * 1.1, 1)],
        tickfont: { family: 'JetBrains Mono', size: 10, color: INK_3 },
        gridcolor: 'rgba(140,180,230,0.08)',
        linecolor: 'rgba(140,180,230,0.15)',
        angle: 90,
        tickangle: 90,
        ticksuffix: ' kts',
      },
      angularaxis: {
        tickmode: 'array',
        tickvals: [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330],
        ticktext: ['0°', '30°', '60°', '90°', '120°', '150°',
                   '180°', '150°', '120°', '90°', '60°', '30°'],
        tickfont: { family: 'JetBrains Mono', size: 10, color: INK_3 },
        gridcolor: 'rgba(140,180,230,0.08)',
        linecolor: 'rgba(140,180,230,0.15)',
        direction: 'clockwise',
        rotation: 90,
      },
      bgcolor: 'rgba(5,19,35,0.8)',
    },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    showlegend: true,
    legend: {
      font: { family: 'JetBrains Mono', size: 10, color: INK_3 },
      bgcolor: 'transparent',
      orientation: 'h',
      x: 0.5,
      xanchor: 'center',
      y: -0.05,
      yanchor: 'top',
    },
    margin: { t: 20, r: 20, b: 60, l: 20 },
    autosize: true,
    hoverlabel: {
      bgcolor: 'rgba(5,19,35,0.95)',
      bordercolor: 'rgba(212,175,110,0.4)',
      font: { family: 'JetBrains Mono', size: 11, color: 'rgb(232,238,247)' },
    },
  }), [maxSog]);

  const config = useMemo(() => ({
    displayModeBar: false,
    responsive: true,
    staticPlot: false,
  }), []);

  return (
    <Plot
      data={data}
      layout={layout}
      config={config}
      style={{ width: '100%', height: '100%' }}
      useResizeHandler
    />
  );
}
