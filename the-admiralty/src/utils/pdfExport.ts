// Genera il report PDF di sessione interamente client-side: i dati
// arrivano gia' filtrati sulla finestra temporale dal Dashboard, qui
// si calcolano solo metriche derivate, si disegna il tracciato in un
// canvas off-DOM e si compone il documento con jsPDF + autoTable.
//
// Pipeline: input -> aggregati -> immagine canvas -> compose PDF.
// Tutte le sezioni sono difensive: se mancano dati per una metrica,
// si scrive "dati insufficienti" invece di lasciare celle vuote.

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  TrackPoint,
  HighResPoint,
  Maneuver,
  SessionInfo,
  EnvironmentInfo,
} from '../types/telemetry';
import type { CoachNote } from './notes';
import { parseBackendTimestamp } from './time';

// --- INPUT ---

export interface PdfExportInput {
  sessionInfo: SessionInfo;
  environment: EnvironmentInfo;
  // Dati gia' filtrati sulla finestra temporale corrente del Dashboard.
  trackData: TrackPoint[];
  highResTrack: HighResPoint[];
  maneuvers: Maneuver[];
  rangeStartMs: number;
  rangeEndMs: number;
  // Parametri utente dal modale di pre-export.
  athleteName: string;
  flyThreshold: number;
  coachNotes: string;
  // Timestamp ISO del primo punto della sessione completa (non filtrato):
  // serve per capire se la finestra selezionata include la partenza.
  sessionStartIsoFull: string;
  fileName: string;
  // Annotazioni temporali dell'allenatore (gia' filtrate sulla finestra
  // temporale dal chiamante). Default array vuoto cosi' il chiamante puo'
  // omettere il campo per sessioni senza note.
  coachAnnotations?: CoachNote[];
}

// --- COLORI ---
// Palette allineata al design system Varea (navy + gold + carta).
const C = {
  ink: '#0a1428',
  inkSoft: '#3a4a5e',
  gold: '#c9a169',
  goldSoft: '#e8cea0',
  paper: '#f5f1e6',
  paperAlt: '#fbf7ec',
  sage: '#8a9a5b',
  amber: '#d4a345',
  terra: '#b65c41',
  border: '#d8cfb8',
  // Andature: blu/verde/arancio in linea con la mappa esistente.
  bolina: '#2a4d8f',
  traverso: '#8a9a5b',
  lasco: '#d4a345',
  unknown: '#9a9a9a',
};

// --- HELPERS ---

const PT_PER_MM = 2.83465;
const mm = (v: number) => v * PT_PER_MM;

function classifyAndatura(raw: string | undefined): 'bolina' | 'traverso' | 'lasco' | 'unknown' {
  const s = (raw || '').toLowerCase();
  if (s.includes('bolina') || s.includes('upwind')) return 'bolina';
  if (s.includes('traverso') || s.includes('reach')) return 'traverso';
  if (s.includes('poppa') || s.includes('lasco') || s.includes('downwind') || s.includes('run') || s.includes('broad')) return 'lasco';
  return 'unknown';
}

function colorForAndatura(c: 'bolina' | 'traverso' | 'lasco' | 'unknown'): string {
  if (c === 'bolina') return C.bolina;
  if (c === 'traverso') return C.traverso;
  if (c === 'lasco') return C.lasco;
  return C.unknown;
}

function fmtClock(ms: number): string {
  // Orario locale leggibile (l'utente ragiona in ora locale, non UTC).
  return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtDuration(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '--';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function safeNum(v: unknown, digits = 1, fallback = '--'): string {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : fallback;
}

function meanStd(vals: number[]): { mean: number; std: number } | null {
  const xs = vals.filter(v => Number.isFinite(v));
  if (xs.length === 0) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { mean, std: Math.sqrt(variance) };
}

function percentile(vals: number[], p: number): number | null {
  const xs = [...vals].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = (p / 100) * (xs.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return xs[lo];
  const frac = idx - lo;
  return xs[lo] * (1 - frac) + xs[hi] * frac;
}

// --- AGGREGATI ---

interface Aggregates {
  sogAvg: number | null;
  sogMax: number | null;
  pctFoiling: number | null;
  vmgUpwind: number | null;
  vmgDownwind: number | null;
  distBolinaPct: number;
  distTraversoPct: number;
  distLascoPct: number;
  distUnknownPct: number;
  pointCount: number;
}

function computeAggregates(track: TrackPoint[], threshold: number): Aggregates {
  const n = track.length;
  if (n === 0) {
    return {
      sogAvg: null, sogMax: null, pctFoiling: null,
      vmgUpwind: null, vmgDownwind: null,
      distBolinaPct: 0, distTraversoPct: 0, distLascoPct: 0, distUnknownPct: 0,
      pointCount: 0,
    };
  }
  let sumSog = 0;
  let maxSog = -Infinity;
  let foiling = 0;
  const vmgUp: number[] = [];
  const vmgDown: number[] = [];
  const counts = { bolina: 0, traverso: 0, lasco: 0, unknown: 0 };
  for (const p of track) {
    const sog = Number(p.sog_knots);
    if (Number.isFinite(sog)) {
      sumSog += sog;
      if (sog > maxSog) maxSog = sog;
      if (sog >= threshold) foiling += 1;
    }
    const cls = classifyAndatura(p.andatura);
    counts[cls] += 1;
    // VMG: serve TWA per proiettare la velocita' lungo l'asse del vento.
    // Convenzione: bolina = guadagno verso vento (cos positivo per |twa| < 90),
    // poppa = allontanamento dal vento (|cos| in modulo).
    if (typeof p.twa === 'number' && Number.isFinite(p.twa) && Number.isFinite(sog)) {
      const twaRad = (p.twa * Math.PI) / 180;
      if (cls === 'bolina') {
        vmgUp.push(sog * Math.cos(twaRad));
      } else if (cls === 'lasco') {
        vmgDown.push(sog * Math.abs(Math.cos(twaRad)));
      }
    }
  }
  const avg = (xs: number[]) => xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return {
    sogAvg: sumSog / n,
    sogMax: maxSog === -Infinity ? null : maxSog,
    pctFoiling: (foiling / n) * 100,
    vmgUpwind: avg(vmgUp),
    vmgDownwind: avg(vmgDown),
    distBolinaPct: (counts.bolina / n) * 100,
    distTraversoPct: (counts.traverso / n) * 100,
    distLascoPct: (counts.lasco / n) * 100,
    distUnknownPct: (counts.unknown / n) * 100,
    pointCount: n,
  };
}

// --- TRACCIATO SU CANVAS ---
// Disegno offline: bounding box geografico, proiezione equirettangolare
// con correzione coseno sulla longitudine, polyline colorata per andatura.
// Ritorna un dataURL PNG da inserire nel PDF; null se non ci sono punti.

function renderTrackToDataUrl(points: (TrackPoint | HighResPoint)[]): string | null {
  if (points.length < 2) return null;
  const W = 1200;
  const H = 700;
  const pad = 30;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Sfondo carta tenue per leggibilita' su PDF in chiaro.
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);

  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (p.lat < latMin) latMin = p.lat;
    if (p.lat > latMax) latMax = p.lat;
    if (p.lon < lonMin) lonMin = p.lon;
    if (p.lon > lonMax) lonMax = p.lon;
  }
  if (!isFinite(latMin) || !isFinite(latMax)) return null;

  const latMid = (latMin + latMax) / 2;
  const lonScale = Math.cos((latMid * Math.PI) / 180);
  const dxGeo = Math.max((lonMax - lonMin) * lonScale, 1e-9);
  const dyGeo = Math.max(latMax - latMin, 1e-9);
  const availW = W - 2 * pad;
  const availH = H - 2 * pad;
  const scale = Math.min(availW / dxGeo, availH / dyGeo);
  const offX = pad + (availW - dxGeo * scale) / 2;
  const offY = pad + (availH - dyGeo * scale) / 2;
  const project = (lat: number, lon: number) => ({
    x: offX + (lon - lonMin) * lonScale * scale,
    y: offY + (latMax - lat) * scale,
  });

  // Cornice
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  // Disegno per segmenti consecutivi, colore = andatura del punto di partenza.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.4;
  let prev: { x: number; y: number } | null = null;
  let prevColor = '';
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      prev = null;
      continue;
    }
    const cur = project(p.lat, p.lon);
    const color = colorForAndatura(classifyAndatura(p.andatura));
    if (prev) {
      if (color !== prevColor) {
        ctx.strokeStyle = color;
        prevColor = color;
      }
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(cur.x, cur.y);
      ctx.stroke();
    } else {
      ctx.strokeStyle = color;
      prevColor = color;
    }
    prev = cur;
  }

  // Marcatori inizio (verde) e fine (rosso) per orientare il lettore.
  const first = points.find(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const last = [...points].reverse().find(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (first) {
    const { x, y } = project(first.lat, first.lon);
    ctx.fillStyle = C.sage;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (last) {
    const { x, y } = project(last.lat, last.lon);
    ctx.fillStyle = C.terra;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  return canvas.toDataURL('image/png');
}

// --- DISTANZA TOTALE ---
// Distanza grezza in NM dal tracciato filtrato, sommando segmenti
// con formula equirettangolare locale (sufficiente per i pochi km
// di una sessione di vela; evita la complessita' del haversine).

function computeDistanceNm(points: (TrackPoint | HighResPoint)[]): number {
  let total = 0;
  let prev: { lat: number; lon: number } | null = null;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      prev = null;
      continue;
    }
    if (prev) {
      const dLat = (p.lat - prev.lat) * Math.PI / 180;
      const dLon = (p.lon - prev.lon) * Math.PI / 180;
      const latMid = ((p.lat + prev.lat) / 2) * Math.PI / 180;
      const x = dLon * Math.cos(latMid);
      const y = dLat;
      const dMeters = Math.sqrt(x * x + y * y) * 6371000;
      total += dMeters;
    }
    prev = { lat: p.lat, lon: p.lon };
  }
  return total / 1852;
}

// --- ANALISI PARTENZA ---
// La consideriamo "inclusa" se il primo timestamp della sessione completa
// cade dentro la finestra (con 30s di tolleranza per spotting di pre-via).

interface StartAnalysis {
  startSog: number | null;
  timeToFirstFoilingSec: number | null;
}

function computeStartAnalysis(highRes: HighResPoint[], threshold: number): StartAnalysis {
  if (highRes.length === 0) {
    return { startSog: null, timeToFirstFoilingSec: null };
  }
  const startPoint = highRes[0];
  const startSog = Number.isFinite(startPoint.sog_knots) ? startPoint.sog_knots : null;
  const t0 = parseBackendTimestamp(startPoint.timestamp);
  let timeToFoiling: number | null = null;
  for (const p of highRes) {
    if (Number.isFinite(p.sog_knots) && p.sog_knots >= threshold) {
      const t = parseBackendTimestamp(p.timestamp);
      if (Number.isFinite(t) && Number.isFinite(t0)) {
        timeToFoiling = (t - t0) / 1000;
      }
      break;
    }
  }
  return { startSog, timeToFirstFoilingSec: timeToFoiling };
}

// --- SAFE TEXT ---
// jsPDF con font built-in usa codifica WinAnsi: lettere accentate latine ok,
// frecce/em-dash unicode possono apparire come glifi mancanti. Sostituisco
// solo i caratteri rischiosi mantenendo tutto il resto invariato.
function safeText(s: string): string {
  return s.replace(/[\u2192\u2190\u2194]/g, '->').replace(/[\u2014\u2013]/g, '-');
}

// --- ENTRY POINT ---

export async function generateSessionReport(input: PdfExportInput): Promise<void> {
  const {
    sessionInfo, environment, trackData, highResTrack, maneuvers,
    rangeStartMs, rangeEndMs, athleteName, flyThreshold, coachNotes,
    sessionStartIsoFull, fileName,
    coachAnnotations = [],
  } = input;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = mm(15);
  const contentW = pageW - 2 * marginX;
  let cursorY = mm(18);

  // ---------- HEADER ----------
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.setTextColor(C.ink);
  doc.text('Varea', marginX, cursorY);
  cursorY += mm(3);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(C.gold);
  doc.text(safeText('TELEMETRY ANALYTICS  ·  REPORT DI SESSIONE'), marginX, cursorY);
  cursorY += mm(2);
  // Filo brass decorativo.
  doc.setDrawColor(C.gold);
  doc.setLineWidth(0.6);
  doc.line(marginX, cursorY, marginX + mm(30), cursorY);
  cursorY += mm(8);

  // ---------- IDENTIFICATIVI SESSIONE ----------
  const periodSecs = Math.max(0, (rangeEndMs - rangeStartMs) / 1000);
  const fullStartMs = parseBackendTimestamp(sessionStartIsoFull);
  const fullDurationSecs = sessionInfo.duration_seconds;
  const fullEndMs = Number.isFinite(fullStartMs) ? fullStartMs + fullDurationSecs * 1000 : NaN;
  const isFullSession = Number.isFinite(fullStartMs) && Number.isFinite(fullEndMs)
    && Math.abs(rangeStartMs - fullStartMs) < 1500 && Math.abs(rangeEndMs - fullEndMs) < 1500;

  // Coordinate medie del segmento per orientare il lettore (in assenza
  // di un nome di luogo dal backend e' la cosa piu' utile da stampare).
  let avgLat: number | null = null;
  let avgLon: number | null = null;
  if (trackData.length > 0) {
    let sLat = 0, sLon = 0, n = 0;
    for (const p of trackData) {
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        sLat += p.lat; sLon += p.lon; n += 1;
      }
    }
    if (n > 0) { avgLat = sLat / n; avgLon = sLon / n; }
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(C.ink);

  const sessionDate = fmtDate(rangeStartMs);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(safeText(`Sessione del ${sessionDate}`), marginX, cursorY);
  cursorY += mm(6);

  // Tabella KV identificativi (nessun header, due colonne).
  const kvIdent: [string, string][] = [
    ['File', fileName || sessionInfo.file_name],
    ['Periodo selezionato', `${fmtClock(rangeStartMs)} -> ${fmtClock(rangeEndMs)} (${fmtDuration(periodSecs)})`],
    ['Coordinate medie', avgLat != null && avgLon != null
      ? `${avgLat.toFixed(4)}, ${avgLon.toFixed(4)}` : 'dati insufficienti'],
    ['TWD stimato', `${sessionInfo ? safeNum(environment.computed_twd_deg, 0) : '--'}°`],
    ['Fonte vento', environment.is_estimated ? 'GPS (stimato)' : 'Stormglass (osservato)'],
    ['Soglia foiling', `${safeNum(flyThreshold, 1)} kts`],
    ['Atleta', athleteName.trim() || '(non specificato)'],
  ];
  if (isFullSession) {
    kvIdent.splice(2, 0, ['Copertura', 'sessione completa']);
  } else {
    kvIdent.splice(2, 0, ['Copertura', 'segmento filtrato']);
  }

  autoTable(doc, {
    startY: cursorY,
    body: kvIdent.map(([k, v]) => [safeText(k), safeText(v)]),
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 10, cellPadding: { top: 2, right: 4, bottom: 2, left: 0 }, textColor: C.ink },
    columnStyles: {
      0: { cellWidth: mm(45), fontStyle: 'bold', textColor: C.inkSoft },
      1: { cellWidth: contentW - mm(45) },
    },
    margin: { left: marginX, right: marginX },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cursorY = (doc as any).lastAutoTable.finalY + mm(6);

  // ---------- METRICHE AGGREGATE ----------
  cursorY = ensureSpace(doc, cursorY, mm(80), pageH);
  cursorY = sectionTitle(doc, 'Metriche aggregate', cursorY, marginX);
  cursorY = sectionDesc(doc, 'Velocita\' media e di picco, tempo trascorso in foiling, VMG e ripartizione delle andature nel periodo.', cursorY, marginX, contentW);

  const agg = computeAggregates(trackData, flyThreshold);
  const distNm = computeDistanceNm(highResTrack.length > 0 ? highResTrack : trackData);

  const aggRows: [string, string, string][] = [
    ['Velocita\' media', agg.sogAvg != null ? safeNum(agg.sogAvg, 1) : 'dati insufficienti', 'kts'],
    ['Velocita\' massima', agg.sogMax != null ? safeNum(agg.sogMax, 1) : 'dati insufficienti', 'kts'],
    ['Tempo in foiling', agg.pctFoiling != null ? `${safeNum(agg.pctFoiling, 1)}` : 'dati insufficienti', '% del periodo'],
    ['Distanza coperta', distNm > 0 ? safeNum(distNm, 2) : 'dati insufficienti', 'NM'],
    ['VMG bolina', agg.vmgUpwind != null ? safeNum(agg.vmgUpwind, 2) : 'dati insufficienti', 'kts'],
    ['VMG lasco/poppa', agg.vmgDownwind != null ? safeNum(agg.vmgDownwind, 2) : 'dati insufficienti', 'kts'],
    ['Tempo in bolina', `${safeNum(agg.distBolinaPct, 1)}`, '%'],
    ['Tempo in traverso', `${safeNum(agg.distTraversoPct, 1)}`, '%'],
    ['Tempo in lasco/poppa', `${safeNum(agg.distLascoPct, 1)}`, '%'],
  ];
  if (agg.distUnknownPct >= 1) {
    aggRows.push(['Andatura non classificata', `${safeNum(agg.distUnknownPct, 1)}`, '%']);
  }

  autoTable(doc, {
    startY: cursorY,
    head: [['Metrica', 'Valore', 'Unita\'']],
    body: aggRows.map(r => r.map(safeText)),
    theme: 'striped',
    headStyles: { fillColor: C.ink, textColor: C.gold, fontStyle: 'bold', fontSize: 10 },
    bodyStyles: { fontSize: 10, textColor: C.ink },
    alternateRowStyles: { fillColor: C.paperAlt },
    columnStyles: {
      0: { cellWidth: mm(70) },
      1: { cellWidth: mm(40), halign: 'right', fontStyle: 'bold' },
      2: { cellWidth: contentW - mm(110), textColor: C.inkSoft },
    },
    margin: { left: marginX, right: marginX },
    styles: { font: 'helvetica' },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cursorY = (doc as any).lastAutoTable.finalY + mm(8);

  // ---------- ANALISI MANOVRE ----------
  cursorY = ensureSpace(doc, cursorY, mm(60), pageH);
  cursorY = sectionTitle(doc, 'Analisi manovre', cursorY, marginX);
  cursorY = sectionDesc(doc, 'Una riga per ogni manovra rilevata nel periodo. Verde = delta-v migliore del 75 percentile, rosso = peggiore del 25.', cursorY, marginX, contentW);

  if (maneuvers.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(C.inkSoft);
    doc.text(safeText('Nessuna manovra rilevata nel periodo selezionato.'), marginX, cursorY);
    cursorY += mm(8);
  } else {
    const dvs = maneuvers.map(m => Number(m.delta_v)).filter(v => Number.isFinite(v));
    const p75 = percentile(dvs, 75);
    const p25 = percentile(dvs, 25);
    const stats = meanStd(dvs);

    const body = maneuvers.map(m => {
      const tsMs = parseBackendTimestamp(m.timestamp);
      const ts = Number.isFinite(tsMs) ? fmtClock(tsMs) : '--';
      const dv = Number(m.delta_v);
      return [
        ts,
        m.type || '--',
        safeNum(m.sog_in, 1),
        safeNum(m.sog_min, 1),
        Number.isFinite(dv) ? dv.toFixed(2) : '--',
        m.duration_s != null ? String(m.duration_s) : '--',
      ];
    });

    autoTable(doc, {
      startY: cursorY,
      head: [['Orario', 'Tipo', 'SOG ingresso (kts)', 'SOG minima (kts)', 'Delta-v (kts)', 'Durata (s)']],
      body: body.map(row => row.map(safeText)),
      theme: 'striped',
      headStyles: { fillColor: C.ink, textColor: C.gold, fontStyle: 'bold', fontSize: 9 },
      bodyStyles: { fontSize: 9, textColor: C.ink },
      alternateRowStyles: { fillColor: C.paperAlt },
      margin: { left: marginX, right: marginX },
      styles: { font: 'helvetica' },
      didParseCell: (data) => {
        // Tinta verde / rossa sulla cella delta-v in base ai percentili.
        if (data.section === 'body' && data.column.index === 4) {
          const raw = maneuvers[data.row.index]?.delta_v;
          const v = Number(raw);
          if (Number.isFinite(v) && p75 != null && v >= p75) {
            data.cell.styles.fillColor = '#dde7c2';
            data.cell.styles.textColor = '#3a4a18';
            data.cell.styles.fontStyle = 'bold';
          } else if (Number.isFinite(v) && p25 != null && v <= p25) {
            data.cell.styles.fillColor = '#f3d4c8';
            data.cell.styles.textColor = '#5a1f10';
            data.cell.styles.fontStyle = 'bold';
          }
        }
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cursorY = (doc as any).lastAutoTable.finalY + mm(4);

    if (stats) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(C.ink);
      doc.text(
        safeText(`Riepilogo delta-v: media ${stats.mean.toFixed(2)} kts  ·  dev. std ${stats.std.toFixed(2)} kts  ·  ${maneuvers.length} manovre`),
        marginX,
        cursorY,
      );
      cursorY += mm(8);
    } else {
      cursorY += mm(4);
    }
  }

  // ---------- TRACCIATO GPS ----------
  cursorY = ensureSpace(doc, cursorY, mm(110), pageH);
  cursorY = sectionTitle(doc, 'Tracciato GPS', cursorY, marginX);
  cursorY = sectionDesc(doc, 'Percorso del periodo, colorato per andatura. Pallino verde = inizio, rosso = fine.', cursorY, marginX, contentW);

  const trackPoints: (TrackPoint | HighResPoint)[] = highResTrack.length > 0 ? highResTrack : trackData;
  const trackImg = renderTrackToDataUrl(trackPoints);
  if (trackImg) {
    const imgW = contentW;
    const imgH = imgW * (700 / 1200);
    cursorY = ensureSpace(doc, cursorY, imgH + mm(12), pageH);
    doc.addImage(trackImg, 'PNG', marginX, cursorY, imgW, imgH);
    cursorY += imgH + mm(3);

    // Legenda andature
    const legendItems: Array<[string, string]> = [
      ['Bolina', C.bolina],
      ['Traverso', C.traverso],
      ['Lasco/Poppa', C.lasco],
    ];
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(C.inkSoft);
    let legendX = marginX;
    for (const [label, color] of legendItems) {
      doc.setFillColor(color);
      doc.rect(legendX, cursorY - mm(2.5), mm(3), mm(2.5), 'F');
      doc.text(safeText(label), legendX + mm(4), cursorY);
      legendX += mm(34);
    }
    cursorY += mm(8);
  } else {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(C.inkSoft);
    doc.text(safeText('Tracciato non disponibile: dati di posizione insufficienti.'), marginX, cursorY);
    cursorY += mm(8);
  }

  // ---------- NOTE ALLENATORE ----------
  // Annotazioni timestampate inserite dall'allenatore tramite click su
  // grafico/mappa. Sezione visibile solo quando ci sono note nel periodo,
  // ordinata cronologicamente (l'array gia' arriva ordinato dal chiamante,
  // ma riordiniamo difensivamente per non dipendere dall'ordine di input).
  if (coachAnnotations.length > 0) {
    cursorY = ensureSpace(doc, cursorY, mm(40), pageH);
    cursorY = sectionTitle(doc, 'Note allenatore', cursorY, marginX);
    cursorY = sectionDesc(doc, 'Annotazioni temporali sui momenti chiave del periodo selezionato.', cursorY, marginX, contentW);

    const sortedNotes = [...coachAnnotations].sort((a, b) => a.timestampSec - b.timestampSec);
    const fullStartMsLocal = parseBackendTimestamp(sessionStartIsoFull);
    const noteRows = sortedNotes.map((n, i) => {
      const ms = Number.isFinite(fullStartMsLocal) ? fullStartMsLocal + n.timestampSec * 1000 : NaN;
      const ts = Number.isFinite(ms) ? fmtClock(ms) : `+${n.timestampSec}s`;
      return [String(i + 1), ts, n.text];
    });

    autoTable(doc, {
      startY: cursorY,
      head: [['#', 'Orario', 'Annotazione']],
      body: noteRows.map(row => row.map(safeText)),
      theme: 'striped',
      headStyles: { fillColor: C.ink, textColor: C.gold, fontStyle: 'bold', fontSize: 10 },
      bodyStyles: { fontSize: 10, textColor: C.ink },
      alternateRowStyles: { fillColor: C.paperAlt },
      columnStyles: {
        0: { cellWidth: mm(10), halign: 'center', fontStyle: 'bold', textColor: C.gold },
        1: { cellWidth: mm(25), fontStyle: 'bold' },
        2: { cellWidth: contentW - mm(35) },
      },
      margin: { left: marginX, right: marginX },
      styles: { font: 'helvetica' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cursorY = (doc as any).lastAutoTable.finalY + mm(8);
  }

  // ---------- ANALISI PARTENZA ----------
  // Includere solo se la finestra include il primo punto della sessione
  // intera (con 60s di tolleranza per pre-via gia' filtrato).
  const includesStart = Number.isFinite(fullStartMs) && rangeStartMs <= fullStartMs + 60_000;
  if (includesStart) {
    cursorY = ensureSpace(doc, cursorY, mm(35), pageH);
    cursorY = sectionTitle(doc, 'Analisi partenza', cursorY, marginX);
    cursorY = sectionDesc(doc, 'Stato dell\'atleta al momento del via e tempo necessario per stabilizzare il foiling.', cursorY, marginX, contentW);

    const startAnalysis = computeStartAnalysis(highResTrack, flyThreshold);
    const startRows: [string, string][] = [
      ['SOG al via', startAnalysis.startSog != null ? `${safeNum(startAnalysis.startSog, 1)} kts` : 'dati insufficienti'],
      ['Tempo al primo foiling', startAnalysis.timeToFirstFoilingSec != null
        ? `${startAnalysis.timeToFirstFoilingSec.toFixed(1)} s`
        : 'soglia mai raggiunta nel periodo'],
    ];
    autoTable(doc, {
      startY: cursorY,
      body: startRows.map(r => r.map(safeText)),
      theme: 'plain',
      styles: { font: 'helvetica', fontSize: 10, cellPadding: { top: 2, right: 4, bottom: 2, left: 0 }, textColor: C.ink },
      columnStyles: {
        0: { cellWidth: mm(60), fontStyle: 'bold', textColor: C.inkSoft },
        1: { cellWidth: contentW - mm(60) },
      },
      margin: { left: marginX, right: marginX },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cursorY = (doc as any).lastAutoTable.finalY + mm(8);
  }

  // ---------- NOTE ----------
  cursorY = ensureSpace(doc, cursorY, mm(70), pageH);
  cursorY = sectionTitle(doc, 'Note', cursorY, marginX);

  const trimmedNotes = coachNotes.trim();
  if (trimmedNotes.length > 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(C.ink);
    const lines = doc.splitTextToSize(safeText(trimmedNotes), contentW);
    doc.text(lines, marginX, cursorY);
    cursorY += lines.length * mm(4.5) + mm(3);
  } else {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(C.inkSoft);
    doc.text(safeText('Nessuna nota inserita.'), marginX, cursorY);
    cursorY += mm(6);
  }

  // Spazio bianco per annotazioni manuali: forzo un blocco di 50mm con
  // margine inferiore di almeno 40mm. Se non ci sta in pagina corrente,
  // vado a pagina nuova per non comprimere il blocco.
  const minBlankBlock = mm(50);
  const minBottomMargin = mm(40);
  if (cursorY + minBlankBlock + minBottomMargin > pageH) {
    doc.addPage();
    cursorY = mm(18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(C.ink);
    doc.text(safeText('Note (continua)'), marginX, cursorY);
    cursorY += mm(8);
  }
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(C.inkSoft);
  doc.text(safeText('Spazio per annotazioni manuali:'), marginX, cursorY);
  cursorY += mm(4);
  doc.setDrawColor(C.border);
  doc.setLineWidth(0.3);
  for (let i = 0; i < 6; i++) {
    doc.line(marginX, cursorY + i * mm(7), marginX + contentW, cursorY + i * mm(7));
  }

  // ---------- FOOTER (numero pagina + timestamp di generazione) ----------
  const totalPages = doc.getNumberOfPages();
  const generatedAt = new Date().toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(C.inkSoft);
    doc.text(safeText(`Generato il ${generatedAt}`), marginX, pageH - mm(8));
    doc.text(safeText(`Pagina ${i} di ${totalPages}`), pageW - marginX, pageH - mm(8), { align: 'right' });
    // Filo brass sottile a fondo pagina
    doc.setDrawColor(C.gold);
    doc.setLineWidth(0.3);
    doc.line(marginX, pageH - mm(11), pageW - marginX, pageH - mm(11));
  }

  // Nome file: include nome atleta se disponibile, sempre data ISO breve.
  const dt = new Date(rangeStartMs);
  const isoShort = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
  const baseName = (athleteName.trim() || 'atleta').replace(/[^a-zA-Z0-9_-]+/g, '_');
  doc.save(`varea_report_${baseName}_${isoShort}.pdf`);
}

// --- HELPERS DI LAYOUT INTERNI ---

function ensureSpace(doc: jsPDF, cursorY: number, needed: number, pageH: number): number {
  const bottomLimit = pageH - mm(20);
  if (cursorY + needed > bottomLimit) {
    doc.addPage();
    return mm(18);
  }
  return cursorY;
}

function sectionTitle(doc: jsPDF, title: string, cursorY: number, marginX: number): number {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(C.ink);
  doc.text(safeText(title), marginX, cursorY);
  // Filo brass sotto il titolo
  doc.setDrawColor(C.gold);
  doc.setLineWidth(0.4);
  doc.line(marginX, cursorY + mm(1.5), marginX + mm(20), cursorY + mm(1.5));
  return cursorY + mm(6);
}

function sectionDesc(doc: jsPDF, desc: string, cursorY: number, marginX: number, contentW: number): number {
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(C.inkSoft);
  const lines = doc.splitTextToSize(safeText(desc), contentW);
  doc.text(lines, marginX, cursorY);
  return cursorY + lines.length * mm(3.8) + mm(2);
}
