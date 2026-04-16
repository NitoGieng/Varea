import React from 'react';
// @ts-ignore
import ReactPlot from 'react-plotly.js';

const Plot = (ReactPlot as any).default || ReactPlot;

export default function TelemetryMap({ trackData = [] }: { trackData: any[] }) {
  
  if (!trackData || trackData.length === 0) {
    return <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm italic">Nessun dato GPS da mostrare</div>;
  }

  const lats = trackData.map((p: any) => p.lat);
  const lons = trackData.map((p: any) => p.lon);
  const speeds = trackData.map((p: any) => p.sog_knots);
  
  // Calcoliamo il centro esatto della mappa invece di prendere solo il primo punto
  const avgLat = lats.reduce((a: number, b: number) => a + b, 0) / lats.length;
  const avgLon = lons.reduce((a: number, b: number) => a + b, 0) / lons.length;

  const hoverTexts = trackData.map((p: any) => 
    `Speed: ${p.sog_knots.toFixed(1)} kts<br>TWA: ${p.twa.toFixed(0)}°<br>Sail: ${p.andatura}`
  );

  return (
    <div className="absolute inset-0 w-full h-full z-0">
      <Plot
        data={[
          {
            type: 'scattermap', // AGGIORNATO DA scattermapbox a scattermap come richiesto dal nuovo Plotly
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
          dragmode: 'pan',
          margin: { l: 0, r: 0, t: 0, b: 0 },
          // AGGIORNATO DA mapbox a map come richiesto dal nuovo Plotly
          map: {
            style: 'carto-positron', // <--- LA MAGIA È QUI: Stile pulito, niente errori server!
            center: { lat: avgLat, lon: avgLon }, // Centro calcolato sulla media
            zoom: 13,
            layers: [], // Previene il rendering di immagini corrotte
            uirevision: 'true' // Impedisce alla mappa di resettare lo zoom quando cambiano i dati
          },
          autosize: true,
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
        }}
        config={{ 
          scrollZoom: true,
          displayModeBar: false
        }}
        useResizeHandler={true}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}