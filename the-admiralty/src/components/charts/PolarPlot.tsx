import React from 'react';
import ReactPlot from 'react-plotly.js';

// Il solito trucco per far andare d'accordo Vite e Plotly
const Plot = (ReactPlot as any).default || ReactPlot;

export default function PolarPlot() {
  // Dati fittizi per la Curva Polare (Predicted Polar) - Velocità target ai vari angoli
  const angles = [0, 30, 45, 60, 90, 120, 150, 180, 210, 240, 270, 300, 315, 330, 360];
  const targetSpeed = [0, 4.5, 6.8, 8.1, 9.2, 10.5, 9.8, 6.5, 9.8, 10.5, 9.2, 8.1, 6.8, 4.5, 0];

  // Dati per il punto "Live" (dal tuo mockup: TWA 42.0°, SOG 8.42 kts)
  const liveAngle = [42];
  const liveSpeed = [8.42];

  return (
    <div className="w-full h-full min-h-[350px] relative flex flex-col items-center justify-center">
      
      {/* Etichette personalizzate sovrapposte al grafico */}
      <div className="absolute top-4 text-[10px] font-bold uppercase tracking-widest text-gold z-10">0° (Upwind)</div>
      <div className="absolute bottom-4 text-[10px] font-bold uppercase tracking-widest text-gray-400 z-10">180° (Downwind)</div>
      
      <Plot
        data={[
          {
            // La curva polare teorica
            type: 'scatterpolar',
            r: targetSpeed,
            theta: angles,
            mode: 'lines',
            name: 'Predicted Polar',
            line: { color: '#b38d56', width: 2, dash: 'dot' }, // Color Gold tratteggiato
            fill: 'toself',
            fillcolor: 'rgba(179, 141, 86, 0.05)',
          },
          {
            // Il punto in tempo reale
            type: 'scatterpolar',
            r: liveSpeed,
            theta: liveAngle,
            mode: 'markers',
            name: 'Live Efficiency',
            marker: { 
              color: '#ef4444', // Rosso acceso per indicare la posizione live
              size: 10,
              line: { color: '#ffffff', width: 2 } 
            },
          }
        ]}
        layout={{
          polar: {
            radialaxis: { 
              visible: true, 
              range: [0, 12], 
              color: '#d1d5db', 
              showticklabels: false, // Nascondiamo i numeri per un look più pulito
              gridcolor: '#f3f4f6'
            },
            angularaxis: { 
              direction: "clockwise", // Lo zero è in alto, i gradi ruotano in senso orario
              rotation: 90, // Ruota il grafico in modo che lo 0° sia in cima (Nord/Vento)
              color: '#d1d5db',
              gridcolor: '#f3f4f6',
              tickfont: { color: '#9ca3af', size: 10 }
            }
          },
          showlegend: false,
          margin: { l: 40, r: 40, t: 40, b: 40 },
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler={true}
      />

      {/* Legenda personalizzata in basso (Stile Reference) */}
      <div className="absolute bottom-4 right-4 bg-white/90 p-4 shadow-sm border border-gray-100 text-xs flex flex-col gap-2 z-10">
         <div className="flex items-center gap-2">
           <div className="w-4 h-[2px] bg-gold border-t border-dashed border-gold"></div>
           <span className="font-bold text-navy-900 tracking-wider text-[10px]">PREDICTED POLAR</span>
         </div>
         <div className="flex items-center gap-2">
           <div className="w-2 h-2 rounded-full bg-red-500 border border-white"></div>
           <span className="font-bold text-navy-900 tracking-wider text-[10px]">LIVE EFFICIENCY</span>
         </div>
      </div>
    </div>
  );
}