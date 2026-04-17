import { useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

export default function StartAnalysis({ trackData, sessionStart }: { trackData: any[], sessionStart: string }) {
  // Impostiamo l'ora di default sulla prima lettura del GPS
  const [startTimeInput, setStartTimeInput] = useState<string>(() => {
    try {
      const d = new Date(sessionStart.replace(' ', 'T') + (sessionStart.endsWith('Z') ? '' : 'Z'));
      return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return "12:00:00";
    }
  });

  // Creiamo il grafico basato sui 2 minuti prima e 1 minuto dopo l'orario inserito
  const chartData = useMemo(() => {
    if (!trackData || trackData.length === 0) return [];
    
    // Trova la data base dalla sessione per non impazzire con i fusi orari
    const baseDateStr = sessionStart.split(' ')[0] || sessionStart.split('T')[0];
    
    // Creiamo l'orario esatto del T=0 (Lo sparo)
    const tZeroDate = new Date(`${baseDateStr}T${startTimeInput}Z`);
    if (isNaN(tZeroDate.getTime())) return [];
    
    const tZeroEpoch = tZeroDate.getTime();
    
    // Finestra: -120s (2 min pre-start) a +60s (1 min post-start)
    const startWindowEpoch = tZeroEpoch - (120 * 1000);
    const endWindowEpoch = tZeroEpoch + (60 * 1000);

    const filtered = trackData.filter((pt) => {
      const ptStr = pt.timestamp.replace(' ', 'T');
      const ptEpoch = new Date(ptStr.endsWith('Z') ? ptStr : ptStr + 'Z').getTime();
      return ptEpoch >= startWindowEpoch && ptEpoch <= endWindowEpoch;
    });

    return filtered.map((pt) => {
      const ptStr = pt.timestamp.replace(' ', 'T');
      const ptEpoch = new Date(ptStr.endsWith('Z') ? ptStr : ptStr + 'Z').getTime();
      // Calcola i secondi di distanza dallo sparo (Negativi = Pre-start, Positivi = Gara in corso)
      const relativeSeconds = Math.round((ptEpoch - tZeroEpoch) / 1000);
      
      return {
        relativeTime: relativeSeconds,
        displayTime: pt.timestamp.split('T')[1]?.substring(0, 8) || pt.timestamp.split(' ')[1]?.substring(0, 8),
        sog: pt.sog_knots,
        cog: pt.cog_deg
      };
    });

  }, [trackData, startTimeInput, sessionStart]);

  // Statistiche calcolate al volo
  const stats = useMemo(() => {
    if (chartData.length === 0) return null;
    
    const preStart = chartData.filter(d => d.relativeTime >= -15 && d.relativeTime <= 0);
    const postStart = chartData.filter(d => d.relativeTime > 0 && d.relativeTime <= 15);
    
    const maxPre = preStart.length > 0 ? Math.max(...preStart.map(d => d.sog)) : 0;
    const avgPost = postStart.length > 0 ? (postStart.reduce((acc, d) => acc + d.sog, 0) / postStart.length) : 0;
    const tZeroPoint = chartData.find(d => d.relativeTime === 0);
    
    return {
      speedAtZero: tZeroPoint ? tZeroPoint.sog : 0,
      maxPreStart: maxPre,
      avgPostStart: avgPost
    };
  }, [chartData]);

  // Formattazione per la legenda del grafico (Aggiunge il - o il + ai secondi)
  const formatXAxis = (tickItem: number) => {
    if (tickItem === 0) return "START";
    return tickItem > 0 ? `+${tickItem}s` : `${tickItem}s`;
  };

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-navy-900 text-white p-3 rounded shadow-lg text-xs font-mono">
          <p className="font-bold mb-1 text-gold">{data.relativeTime === 0 ? "IL MOMENTO DELLO SPARO" : data.relativeTime < 0 ? `${Math.abs(data.relativeTime)} SECONDI ALLO START` : `${data.relativeTime} SECONDI DI GARA`}</p>
          <p>Ora: {data.displayTime}</p>
          <p className="text-sm font-bold mt-2">Velocità: {data.sog.toFixed(1)} kts</p>
          <p className="text-gray-400">Rotta: {data.cog.toFixed(0)}°</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="p-8 lg:p-12 max-w-[1600px] mx-auto w-full">
      <header className="mb-8">
        <h2 className="text-3xl font-serif font-black text-navy-900 leading-none">Analisi Partenza (Start)</h2>
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500 mt-2">
          Finestra tattica: 2 Minuti pre-start / 1 Minuto post-start
        </p>
      </header>

      {/* PANNELLO DI CONTROLLO */}
      <div className="bg-white p-6 shadow-sm border border-gray-200 rounded mb-8 flex flex-col md:flex-row items-end gap-6 justify-between">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Ora esatta del T=0 (Lo Sparo)</label>
          <div className="flex items-center bg-gray-50 border border-gray-200 rounded focus-within:border-gold overflow-hidden w-fit">
            <input 
              type="time" 
              step="1" 
              value={startTimeInput} 
              onChange={(e) => setStartTimeInput(e.target.value)} 
              className="py-2 px-4 bg-transparent text-lg font-mono font-bold text-navy-900 outline-none" 
            />
          </div>
          <p className="text-xs text-gray-400 mt-2">Inserisci l'orario reale in cui il comitato ha dato il via.</p>
        </div>

        {stats && (
          <div className="flex gap-4">
            <div className="bg-gray-50 p-4 rounded border border-gray-100 text-center min-w-[140px]">
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Accelerazione (-15s)</div>
              <div className="text-xl font-serif font-bold text-navy-900">{stats.maxPreStart.toFixed(1)} <span className="text-xs font-sans text-gray-500">kts</span></div>
            </div>
            <div className="bg-gold/10 p-4 rounded border border-gold/20 text-center min-w-[140px]">
              <div className="text-[10px] font-bold text-gold uppercase tracking-widest mb-1">Crossing a T=0</div>
              <div className="text-2xl font-serif font-bold text-navy-900">{stats.speedAtZero.toFixed(1)} <span className="text-xs font-sans text-gray-500">kts</span></div>
            </div>
            <div className="bg-gray-50 p-4 rounded border border-gray-100 text-center min-w-[140px]">
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Crociera (+15s)</div>
              <div className="text-xl font-serif font-bold text-navy-900">{stats.avgPostStart.toFixed(1)} <span className="text-xs font-sans text-gray-500">kts</span></div>
            </div>
          </div>
        )}
      </div>

      {/* GRAFICO DELLA PARTENZA */}
      <div className="bg-white shadow-sm border border-gray-200 rounded p-6 h-[500px]">
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
              <XAxis 
                dataKey="relativeTime" 
                tickFormatter={formatXAxis} 
                minTickGap={30}
                tick={{ fill: '#9ca3af', fontSize: 12, fontWeight: 'bold' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis 
                domain={['auto', 'auto']} 
                tick={{ fill: '#9ca3af', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(val) => `${val} kts`}
              />
              <Tooltip content={<CustomTooltip />} />
              
              {/* LA LINEA DI START (T=0) */}
              <ReferenceLine x={0} stroke="#d4af37" strokeWidth={3} strokeDasharray="4 4" label={{ position: 'top', value: 'START', fill: '#d4af37', fontSize: 14, fontWeight: 'bold' }} />
              
              {/* LA CURVA DELLA VELOCITÀ */}
              <Line 
                type="monotone" 
                dataKey="sog" 
                stroke="#061325" 
                strokeWidth={3} 
                dot={false}
                activeDot={{ r: 6, fill: "#d4af37", stroke: "#fff", strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-gray-400">
            <svg className="w-12 h-12 mb-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <p>Nessun dato GPS in questo orario.</p>
            <p className="text-xs mt-1">Usa la barra qui sopra per cercare il momento esatto della partenza.</p>
          </div>
        )}
      </div>

    </div>
  );
}