import React from 'react';
// @ts-ignore
import ReactPlot from 'react-plotly.js';

const Plot = (ReactPlot as any).default || ReactPlot;

// Diciamo a React che questo componente si aspetta di ricevere una lista di dati
export default function TelemetryMap({ trackData = [] }: { trackData: any[] }) {
  
  // Se i dati non sono ancora arrivati o sono vuoti, non disegniamo nulla per evitare errori
  if (!trackData || trackData.length === 0) {
    return <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm italic">Nessun dato GPS da mostrare</div>;
  }

  const lats = trackData.map((p: any) => p.lat);
  const lons = trackData.map((p: any) => p.lon);
  const speeds = trackData.map((p: any) => p.sog_knots);
  
  const hoverTexts = trackData.map((p: any) => 
    `Speed: ${p.sog_knots.toFixed(1)} kts<br>TWA: ${p.twa.toFixed(0)}°<br>Sail: ${p.andatura}`
  );

  return (
    <div className="absolute inset-0 w-full h-full z-0">
      <Plot
        data={[
          {
            type: 'scattermapbox',
            lat: lats,
            lon: lons,
            mode: 'markers+lines',
            marker: {
              size: 6,
              color: speeds,
              colorscale: 'Plasma',
              showscale: true,
              colorbar: { 
                title: 'SOG (kts)',
                thickness: 15,
                len: 0.8,
                outlinewidth: 0,
                tickfont: { family: 'Inter, sans-serif', size: 10 }
              }
            },
            line: { width: 1, color: '#061325' },
            text: hoverTexts,
            hoverinfo: 'text'
          }
        ]}
        layout={{
          dragmode: 'pan', // <-- 1. Clicca e trascina per spostarti sulla mappa come su Google Maps
          margin: { l: 0, r: 0, t: 0, b: 0 },
          mapbox: {
            style: 'open-street-map',
            center: { lat: lats[0] || 0, lon: lons[0] || 0 },
            zoom: 12
          },
          autosize: true,
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
        }}
        config={{ 
          scrollZoom: true, // <-- 2. Sblocca la rotellina del mouse o il pinch-to-zoom sul trackpad!
          displayModeBar: false // (Opzionale) Nasconde la barra degli strumenti in alto a destra per un look più pulito
        }}
        useResizeHandler={true}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}