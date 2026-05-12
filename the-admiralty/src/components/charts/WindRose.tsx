// Rosa dei venti compatta in stile cockpit. Componente puramente
// presentazionale: riceve la direzione del vento (TWD in gradi) e
// disegna l'indicatore. I colori sono pinnati ai token cockpit
// (--gold/--gold-2/--ink-3/--ink-4) cosi' la rosa segue il tema
// senza override locali.

import { useTranslation } from 'react-i18next';

interface Props {
  size?: number;
  dir: number;
}

export default function WindRose({ size = 88, dir }: Props) {
  const { t } = useTranslation();
  const r = size / 2;

  // 36 tacche radiali, una ogni 10 gradi. Ogni 90 gradi (i % 9 === 0)
  // disegna una tacca lunga e piu' visibile per marcare i quadranti.
  const ticks = [];
  for (let i = 0; i < 36; i++) {
    const a = (i * 10) * Math.PI / 180;
    const isMajor = i % 9 === 0;
    const len = isMajor ? 8 : 4;
    ticks.push(
      <line
        key={i}
        x1={r + Math.sin(a) * (r - 2)}
        y1={r - Math.cos(a) * (r - 2)}
        x2={r + Math.sin(a) * (r - 2 - len)}
        y2={r - Math.cos(a) * (r - 2 - len)}
        stroke={isMajor ? 'rgba(140,180,230,0.45)' : 'rgba(140,180,230,0.18)'}
        strokeWidth="1"
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={t('windRose.aria', { deg: Math.round(dir) })}
    >
      {/* Cerchio esterno: bordo brass molto leggero + fill quasi nullo
          per dare profondita' senza far rumore. */}
      <circle
        cx={r}
        cy={r}
        r={r - 2}
        fill="rgba(212,175,110,0.03)"
        stroke="rgba(212,175,110,0.18)"
      />
      {/* Cerchio interno: linea bluastra molto debole, suggerisce un
          quadrante secondario tipo bussola da plancia. */}
      <circle
        cx={r}
        cy={r}
        r={r - 14}
        fill="none"
        stroke="rgba(140,180,230,0.08)"
      />
      {ticks}

      {/* Cardinali — N evidenziato in gold, gli altri tre in ink-4
          per gerarchia visiva. */}
      <text
        x={r}
        y={11}
        fill="rgb(var(--gold))"
        fontFamily="var(--mono)"
        fontSize="8"
        textAnchor="middle"
        letterSpacing="0.1em"
      >
        N
      </text>
      <text
        x={size - 7}
        y={r + 3}
        fill="rgb(var(--ink-4))"
        fontFamily="var(--mono)"
        fontSize="8"
        textAnchor="middle"
      >
        E
      </text>
      <text
        x={r}
        y={size - 4}
        fill="rgb(var(--ink-4))"
        fontFamily="var(--mono)"
        fontSize="8"
        textAnchor="middle"
      >
        S
      </text>
      <text
        x={7}
        y={r + 3}
        fill="rgb(var(--ink-4))"
        fontFamily="var(--mono)"
        fontSize="8"
        textAnchor="middle"
      >
        W
      </text>

      {/* Lancetta rotante: ruota dell'angolo TWD (0 = nord, sense
          orario tipico delle bussole). Linea verticale + freccia +
          mozzo centrale per il look "strumento". */}
      <g transform={`translate(${r} ${r}) rotate(${dir})`}>
        <line
          x1="0"
          y1="6"
          x2="0"
          y2={-(r - 12)}
          stroke="rgb(var(--gold))"
          strokeWidth="1.5"
        />
        <polygon
          points={`0,${-(r - 10)} -4,${-(r - 18)} 4,${-(r - 18)}`}
          fill="rgb(var(--gold))"
        />
        <circle r="2.5" fill="rgb(var(--gold-2))" />
      </g>

      {/* Etichetta gradi sotto al mozzo — ridondante col readout
          numerico esterno ma utile quando la rosa viene riusata
          stand-alone (es. tooltip o miniatura). */}
      <text
        x={r}
        y={r + 18}
        fill="rgb(var(--ink-3))"
        fontFamily="var(--mono)"
        fontSize="7"
        textAnchor="middle"
        letterSpacing="0.1em"
      >
        {Math.round(dir)}°
      </text>
    </svg>
  );
}
