// Strip "cockpit" sotto la SubBar (filtro temporale): mostra in chiave
// avionics i dati di sessione che il pilota vorrebbe sempre tenere d'occhio
// — durata, distanza, vento, fonte vento, coordinate. Il contenuto e'
// puramente visivo: tutti i numeri arrivano dallo stato sessione gestito
// dal Dashboard, qui non vengono ne' calcolati ne' filtrati.
import { useTranslation } from 'react-i18next';

interface Props {
  hasSession: boolean;
  durationSeconds?: number;
  distanceNm?: number;
  twdDeg?: number;
  isEstimated?: boolean;
  lat?: number;
  lon?: number;
}

const fmtDuration = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const fmtCoord = (lat: number, lon: number): string => {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(3)}° ${ns} · ${Math.abs(lon).toFixed(3)}° ${ew}`;
};

export default function StatusStrip({
  hasSession,
  durationSeconds,
  distanceNm,
  twdDeg,
  isEstimated,
  lat,
  lon,
}: Props) {
  const { t } = useTranslation();
  const baseStyle: React.CSSProperties = {
    height: 30,
    borderTop: '1px solid var(--line)',
    borderBottom: '1px solid var(--line)',
    background: 'rgba(255, 255, 255, 0.012)',
    fontFamily: 'var(--mono)',
    fontSize: 10,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: 'rgb(var(--ink-3))',
  };

  // Stato vuoto: strip presente ma con un solo placeholder centrato. Mantiene
  // il rhythm visivo della pagina anche prima del primo upload.
  if (!hasSession) {
    return (
      <div
        className="w-full flex items-center justify-center"
        style={baseStyle}
      >
        <span style={{ color: 'rgb(var(--ink-4))' }}>
          {t('statusStrip.noSession')}
        </span>
      </div>
    );
  }

  return (
    <div
      className="w-full flex items-center px-6 lg:px-12 gap-0"
      style={baseStyle}
    >
      <div className="flex items-center gap-0 flex-wrap min-w-0 flex-1">
        <Cell first>
          <span className="cockpit-led" aria-hidden style={{ marginRight: 8 }} />
          {t('statusStrip.live')}
        </Cell>
        {durationSeconds != null && (
          <Cell>
            <Label>{t('statusStrip.duration')}</Label>
            <Mono>{fmtDuration(durationSeconds)}</Mono>
          </Cell>
        )}
        {distanceNm != null && (
          <Cell>
            <Label>{t('statusStrip.distance')}</Label>
            <Mono>{distanceNm.toFixed(1)} NM</Mono>
          </Cell>
        )}
        <Cell>
          <Label>{t('statusStrip.tws')}</Label>
          {/* TWS non esposto dal backend (vedi src/environment): placeholder
              "--" honest invece di fake. */}
          <Mono dim>-- kts</Mono>
        </Cell>
        {twdDeg != null && (
          <Cell>
            <Label>{t('statusStrip.twd')}</Label>
            <Mono>{Math.round(twdDeg).toString().padStart(3, '0')}°</Mono>
          </Cell>
        )}
        {isEstimated != null && (
          <Cell>
            <span
              className="cockpit-led"
              aria-hidden
              style={{
                marginRight: 8,
                // amber per Stormglass (sync), red dim per fallback GPS
                ['--led-color' as string]: isEstimated
                  ? 'rgb(var(--amber))'
                  : 'rgb(var(--green))',
              }}
            />
            <Label>{t('statusStrip.stormglass')}</Label>
            <Mono>{isEstimated ? t('statusStrip.gpsFallback') : t('statusStrip.sync')}</Mono>
          </Cell>
        )}
      </div>

      {lat != null && lon != null && (
        <div className="shrink-0 hidden md:flex items-center pl-4">
          <Mono>{fmtCoord(lat, lon)}</Mono>
        </div>
      )}
    </div>
  );
}

// Sotto-componenti puramente presentazionali. Cell aggiunge il filo sinistro
// dopo il primo elemento, Label e Mono separano la "etichetta" mono-uppercase
// dal "valore" mono-tabular per ottenere l'allineamento da cockpit.

function Cell({ children, first = false }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div
      className="flex items-center gap-2 whitespace-nowrap"
      style={{
        paddingLeft: first ? 0 : 18,
        paddingRight: 18,
        borderLeft: first ? 'none' : '1px solid var(--line)',
      }}
    >
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: 'rgb(var(--ink-4))' }}>{children}</span>
  );
}

function Mono({ children, dim = false }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <span
      className="tabular"
      style={{ color: dim ? 'rgb(var(--ink-4))' : 'rgb(var(--ink-2))' }}
    >
      {children}
    </span>
  );
}
