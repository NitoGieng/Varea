import os
import numpy as np
import pandas as pd
from typing import List, Dict, Any

# Finestre di classificazione virata/strambata (secondi).
# Derivate dal lag del filtro Schmitt+dwell (~6-7s): la finestra parte a 8s
# dall'evento per campionare l'andatura stabile, non la transizione in corso.
_CLASS_WINDOW_LAG_S = 8
_CLASS_WINDOW_LEN_S = 12

# Sanity-gate fisica sul Δ-COG a due livelli.
# HARD (45°): manovre ampie, accettate incondizionatamente.
# SOFT (25°): sotto questa soglia ogni flip di mure e' rumore TWD — scartato
# sempre. In mezzo [25°,45°] l'accettazione richiede una firma di crossing
# fisico (cross_min<25° o cross_max>155°): strambate reali in wave-riding
# hanno spesso Δcog attorno ai 40° ma firma di crossing a poppa piena
# inequivocabile.
# Finestre pre/post [i-10,i-5] e [i+5,i+10] a 1Hz: 5s ciascuna, fuori dal
# cono del turno dove il COG ruota, vicine abbastanza da campionare la
# direzione di rotta stabile prima e dopo.
_COG_GATE_HARD = 45.0
_COG_GATE_SOFT = 25.0
_COG_PRE_LO = 10
_COG_PRE_HI = 5
_COG_POST_LO = 5
_COG_POST_HI = 10

# Bande di riconoscimento del crossing fisico.
# Virata: twa_signed attraversa 0° → min(|TWA|) < 25°.
# Strambata: twa_signed attraversa ±180° → max(|TWA|) > 155°.
# Per il gate soft (Δcog∈[25,45]) richiedo ≥2 sample in banda per contarlo
# come segnale reale, non un singolo sample rumoroso: un glitch TWD
# transitorio puo' produrre un min/max sotto/sopra soglia per un istante
# senza che ci sia un vero passaggio fisico.
_CROSS_VIRATA_DEG = 25.0
_CROSS_STRAMBATA_DEG = 155.0
_CROSS_SIGNAL_MIN_SAMPLES = 2

# Log diagnostico: attivare con env var VAREA_DEBUG_MANEUVERS=1 prima di
# lanciare api.py / main.py / streamlit. Stampa una riga per manovra con
# i segnali usati dal voto di classificazione.
_DEBUG_CLASS = os.environ.get('VAREA_DEBUG_MANEUVERS', '').strip() == '1'


class ManeuverAnalyzer:
    """
    Analizza la cinematica per taggare le andature e calcolare le metriche 
    di efficienza (Delta V, TTR Dinamico al 50% e Durata Totale).
    """
    
    def __init__(self, min_leg_time: int = 15,
                 hysteresis_deg: float = 7.0,
                 smooth_window_s: int = 5,
                 dwell_samples: int = 4):
        self.min_leg_time = min_leg_time
        self.hysteresis_deg = hysteresis_deg
        self.smooth_window_s = smooth_window_s
        self.dwell_samples = dwell_samples

    @staticmethod
    def angular_diff(a, b):
        return (a - b + 180) % 360 - 180

    @staticmethod
    def _circular_mean_deg(values_deg: np.ndarray) -> float:
        """Media di angoli in gradi, sicura al wrap ±180° via atan2(sin, cos)."""
        if len(values_deg) == 0:
            return float('nan')
        rad = np.radians(values_deg)
        return float(np.degrees(np.arctan2(np.mean(np.sin(rad)), np.mean(np.cos(rad)))))

    def _compute_stable_mure(self, twa_signed: pd.Series) -> pd.Series:
        """
        Calcola la mure (tack) stabile robusta al rumore del vento.

        Tre difese in cascata, tutte su rappresentazione circolare per non
        rompersi a poppa piena (|TWA|≈180°):

        1. Media circolare (smooth_window_s secondi, centrata). Invece di
           mediana/media su numeri, che tratta +179° e -179° come estremi
           opposti e oscilla al wrap, passa per sin/cos: smooth(twa) =
           atan2(mean(sin(twa)), mean(cos(twa))). E' l'unica media che
           rispetta la topologia del cerchio: per una sequenza a poppa
           piena [+179,-179,+179,-179] restituisce ~±180° stabile invece
           che alternare tra +179° e -179°.

        2. Schmitt trigger su sin(twa_smoothed). La mure e' sign(sin(TWA)):
           positivo = mura dritta, negativo = mura sinistra. La banda morta
           |sin(twa)| < sin(H°) e' intrinsecamente simmetrica — attiva sia
           quando TWA e' vicino a 0° (bolina) sia quando e' vicino a ±180°
           (poppa piena). Il vecchio Schmitt su TWA grezza aveva banda solo
           attorno a 0°, lasciando poppa piena scoperta — l'origine delle
           "manovre fantasma" in downwind.

        3. Dwell filter (dwell_samples secondi consecutivi nel nuovo stato):
           conferma il flip solo se la nuova mure persiste. Immunizza
           contro i rollii lenti delle strambate dove TWA attraversa lo
           zero/i±180, torna indietro per onda, e riattraversa.
        """
        # 1. Media circolare: robusta al wrap angolare ±180°
        theta = np.radians(twa_signed.to_numpy())
        sin_s = pd.Series(np.sin(theta), index=twa_signed.index)
        cos_s = pd.Series(np.cos(theta), index=twa_signed.index)
        win = self.smooth_window_s
        sin_smooth = sin_s.rolling(window=win, center=True, min_periods=1).mean().to_numpy()
        cos_smooth = cos_s.rolling(window=win, center=True, min_periods=1).mean().to_numpy()

        n = len(sin_smooth)
        mure = np.zeros(n, dtype=int)

        # Soglia della banda morta sul piano sin. sin(H°) e' naturalmente
        # simmetrica: |sin(twa)|<sin(H) attiva la banda a TWA∈(-H,H) e anche
        # a TWA∈(180-H,180)∪(-180,-180+H). Con H=7° la soglia e' ~0.122.
        sin_H = float(np.sin(np.radians(self.hysteresis_deg)))

        # Stato iniziale: media del sin smussato sui primi 15s. Basarsi sul
        # singolo sample sin_smooth[0] e' fragile — i primi 1-2s sono spesso
        # contaminati dal warm-up del GPS (COG rumoroso, TWA ballerino). Se
        # quel rumore inverte il segno iniziale, il primo flip corretto appena
        # il filtro si stabilizza viene contato come manovra artificiale.
        # 15s sono abbondanti per coprire il lag del rolling + dwell filter
        # e mediare via eventuali transienti GPS senza perdere l'evidenza di
        # una manovra vera avvenuta oltre.
        warmup = min(15, n)
        initial_sin = float(np.mean(sin_smooth[:warmup]))
        current_mure = 1 if initial_sin >= 0 else -1
        mure[0] = current_mure

        candidate_mure = current_mure
        dwell_count = 0

        # 2+3. Schmitt trigger simmetrico + dwell filter
        for i in range(1, n):
            s = sin_smooth[i]
            if s > sin_H:
                proposed = 1
            elif s < -sin_H:
                proposed = -1
            else:
                # Dentro banda morta (vicino a 0° O a ±180°): mantieni stato
                proposed = current_mure

            if proposed == current_mure:
                candidate_mure = current_mure
                dwell_count = 0
            else:
                # Proposta di flip: accumula dwell solo se coerente
                if proposed == candidate_mure:
                    dwell_count += 1
                else:
                    candidate_mure = proposed
                    dwell_count = 1
                # Conferma il cambio solo dopo dwell_samples secondi consecutivi
                if dwell_count >= self.dwell_samples:
                    current_mure = proposed
                    dwell_count = 0

            mure[i] = current_mure

        return pd.Series(mure, index=twa_signed.index)

    def tag_points_of_sail(self, df: pd.DataFrame, twd_series: pd.Series) -> pd.DataFrame:
        twa_abs = self.angular_diff(df['cog_deg'], twd_series).abs()
        conditions = [
            (twa_abs <= 70),                     
            (twa_abs > 70) & (twa_abs <= 120),   
            (twa_abs > 120)                      
        ]
        choices = ['Bolina', 'Traverso', 'Lasco/Poppa']
        df['andatura'] = np.select(conditions, choices, default='Sconosciuta')
        df['twa'] = twa_abs
        return df

    def detect_maneuvers(self, df: pd.DataFrame, twd_series: pd.Series) -> List[Dict[str, Any]]:
        maneuvers = []
        if len(df) < 30:
            return maneuvers

        df['cum_dist_nm'] = (df['sog_knots'] / 3600).cumsum()
        
        df['twa_signed'] = self.angular_diff(df['cog_deg'], twd_series)
        # Mure stabile: rolling median + Schmitt trigger + dwell filter.
        # Rimpiazza il precedente np.where(twa_signed >= 0, 1, -1) che era
        # fragile vicino a TWA=0 (bolina) e TWA=±180 (poppa piena).
        df['mure'] = self._compute_stable_mure(df['twa_signed'])
        df['cambio_mure'] = df['mure'].diff().fillna(0) != 0

        change_indices = df.index[df['cambio_mure']].tolist()
        
        last_man_idx = 0
        last_man_dist = float(df['cum_dist_nm'].iloc[0])

        for idx_timestamp in change_indices:
            i = df.index.get_loc(idx_timestamp)
            
            if i - last_man_idx < self.min_leg_time:
                continue

            # Finestra di crossing fisico: centrata sul momento fisico della
            # manovra (i - lag_filtro ≈ i-6), allargata a [i-15, i+5]. Gli
            # estremi di questa finestra sono la firma diretta del tipo di
            # manovra (0° = virata, ±180° = strambata) e guidano SIA il gate
            # Δ-COG a due livelli SIA la classificazione crossing-first.
            twa_abs_series = df['twa_signed'].abs()
            cross_lo = max(0, i - 15)
            cross_hi = min(len(df), i + 5)
            cross_window = twa_abs_series.iloc[cross_lo:cross_hi]
            cross_min = float(cross_window.min()) if len(cross_window) else float('nan')
            cross_max = float(cross_window.max()) if len(cross_window) else float('nan')
            count_near_zero = int((cross_window < 30).sum())
            count_near_pi = int((cross_window > 150).sum())
            # Conteggio persistente nelle bande di crossing (sotto 25° o sopra
            # 155°). Il min/max singolo puo' essere un glitch: richiedo ≥2
            # sample per qualificare come segnale fisico reale. Questo chiude
            # il gate soft ai flip di mure in TWD rumoroso che prima
            # passavano per un singolo sample sotto/sopra soglia.
            n_cross_virata = int((cross_window < _CROSS_VIRATA_DEG).sum())
            n_cross_strambata = int((cross_window > _CROSS_STRAMBATA_DEG).sum())
            has_crossing_signal = (
                len(cross_window) >= 5 and
                (n_cross_virata >= _CROSS_SIGNAL_MIN_SAMPLES or
                 n_cross_strambata >= _CROSS_SIGNAL_MIN_SAMPLES)
            )

            # Sanity-gate fisica a due livelli. Un flip di mure senza rotazione
            # del COG e' sempre TWD rumoroso. Ma strambate reali in wave-riding
            # hanno Δcog attorno ai 40°, sotto la soglia HARD di 45° — con la
            # firma di crossing passano comunque. Sotto SOFT 25°: sempre rumore.
            pre_cog_lo = max(0, i - _COG_PRE_LO)
            pre_cog_hi = max(0, i - _COG_PRE_HI)
            post_cog_lo = min(len(df), i + _COG_POST_LO)
            post_cog_hi = min(len(df), i + _COG_POST_HI)
            pre_cog_win = df['cog_deg'].iloc[pre_cog_lo:pre_cog_hi].to_numpy()
            post_cog_win = df['cog_deg'].iloc[post_cog_lo:post_cog_hi].to_numpy()

            # Finestre piene richieste: a inizio/fine sessione accetto senza
            # gate (backward compat su manovre ai bordi / file corti).
            if len(pre_cog_win) >= 3 and len(post_cog_win) >= 3:
                pre_cog = self._circular_mean_deg(pre_cog_win)
                post_cog = self._circular_mean_deg(post_cog_win)
                delta_cog = abs(self.angular_diff(post_cog, pre_cog))
                if delta_cog < _COG_GATE_SOFT:
                    if _DEBUG_CLASS:
                        print(
                            f"[maneuvers] i={i} ts={idx_timestamp} "
                            f"SCARTATA: Δcog={delta_cog:.1f}° < {_COG_GATE_SOFT}° "
                            f"(pre={pre_cog:.1f}° post={post_cog:.1f}°)",
                            flush=True,
                        )
                    continue
                if delta_cog < _COG_GATE_HARD and not has_crossing_signal:
                    if _DEBUG_CLASS:
                        print(
                            f"[maneuvers] i={i} ts={idx_timestamp} "
                            f"SCARTATA: Δcog={delta_cog:.1f}° in "
                            f"[{_COG_GATE_SOFT},{_COG_GATE_HARD}] senza "
                            f"crossing signal (cross_min={cross_min:.1f} "
                            f"cross_max={cross_max:.1f})",
                            flush=True,
                        )
                    continue

            # Classificazione crossing-first: la fisica dice
            # cross_max>155° ⇔ passaggio a poppa ⇔ Strambata;
            # cross_min<25°  ⇔ passaggio a prua  ⇔ Virata.
            # Segnale diretto, non contaminato dal lag del filtro. Il voto
            # precedente su TWA-mediana + andatura pre/post + count era
            # ingannato da gybes veloci (pochi sample in banda alta) e da
            # andature a cavallo del traverso: entrambi casi reali dal log
            # test dell'utente. Il voto TWA-mediana resta solo come fallback
            # quando il crossing non ha letture utili (finestra monca).
            m_type = None
            pre_twa = None
            post_twa = None

            if len(cross_window) >= 5:
                near_zero = cross_min < _CROSS_VIRATA_DEG
                near_pi = cross_max > _CROSS_STRAMBATA_DEG
                if near_zero and not near_pi:
                    m_type = 'Virata'
                elif near_pi and not near_zero:
                    m_type = 'Strambata'
                elif near_zero and near_pi:
                    # Entrambe le bande toccate: tie-breaker in tre livelli.
                    # 1) Persistenza: vince la banda con piu' sample (n_low su
                    #    soglia 30°, n_high su soglia 150°). Un singolo
                    #    estremo vicino a 0° o 180° puo' essere un glitch
                    #    (rumore TWD, diff GPS su barca ferma): ignorarlo e
                    #    guardare quanti secondi la barca ha passato in
                    #    ciascuna banda e' piu' affidabile.
                    # 2) Distanza: solo a pareggio di persistenza, vince
                    #    l'estremo piu' vicino alla sua banda di riferimento.
                    if count_near_zero > count_near_pi:
                        m_type = 'Virata'
                    elif count_near_pi > count_near_zero:
                        m_type = 'Strambata'
                    else:
                        m_type = 'Virata' if cross_min <= (180.0 - cross_max) else 'Strambata'

            if m_type is None:
                # Fallback: mediana |TWA| pre/post (il piu' robusto dei voti
                # originali). Usa le stesse finestre stabili del detector
                # precedente, separate di LAG_S secondi dall'evento per stare
                # fuori dal cono di transizione del filtro Schmitt.
                pre_lo = max(0, i - _CLASS_WINDOW_LAG_S - _CLASS_WINDOW_LEN_S)
                pre_hi = max(0, i - _CLASS_WINDOW_LAG_S)
                post_lo = min(len(df), i + _CLASS_WINDOW_LAG_S)
                post_hi = min(len(df), i + _CLASS_WINDOW_LAG_S + _CLASS_WINDOW_LEN_S)
                pre_twa = twa_abs_series.iloc[pre_lo:pre_hi]
                post_twa = twa_abs_series.iloc[post_lo:post_hi]

                pre_vote = float(pre_twa.median()) if len(pre_twa) >= 4 else None
                post_vote = float(post_twa.median()) if len(post_twa) >= 4 else None

                # Voto asimmetrico pre-dominante. La pos of sail PRIMA della
                # manovra determina la geometria del crossing: da lasco/poppa
                # (|TWA|>100°) l'unica transizione fisica a un'altra andatura
                # e' attraverso poppa (strambata); da bolina stretta (|TWA|<80°)
                # e' attraverso prua (virata). La media pre/post precedente
                # veniva annacquata quando pre e post stavano su lati opposti
                # (es. pre=116° post=60° → media 88° < 90° → falsa Virata),
                # perdendo strambate scrappy che rientravano in bolina dopo
                # il gybe. La fascia [80°,100°] resta grigia: conservo il voto
                # mediato come fallback.
                if pre_vote is not None:
                    if pre_vote > 100.0:
                        m_type = 'Strambata'
                    elif pre_vote < 80.0:
                        m_type = 'Virata'
                    elif post_vote is not None:
                        combined = (pre_vote + post_vote) / 2.0
                        m_type = 'Virata' if combined < 90 else 'Strambata'
                    else:
                        m_type = 'Virata' if pre_vote < 90 else 'Strambata'
                elif post_vote is not None:
                    m_type = 'Virata' if post_vote < 90 else 'Strambata'
                else:
                    # Ultima risorsa: sample singolo pre-evento
                    m_type = 'Virata' if abs(float(df['twa_signed'].iloc[i-1])) < 90 else 'Strambata'

            if _DEBUG_CLASS:
                pre_med = float(pre_twa.median()) if pre_twa is not None and len(pre_twa) else float('nan')
                post_med = float(post_twa.median()) if post_twa is not None and len(post_twa) else float('nan')
                print(
                    f"[maneuvers] i={i} ts={idx_timestamp} "
                    f"cross_min={cross_min:.1f} cross_max={cross_max:.1f} "
                    f"n_low={count_near_zero} n_high={count_near_pi} "
                    f"twa_pre={pre_med:.1f} twa_post={post_med:.1f} -> {m_type}",
                    flush=True,
                )
            
            # 1. CERCHIAMO IL VERO MINIMO
            search_start = max(0, i - 2)
            search_end = min(len(df)-1, i + 25)
            window = df.iloc[search_start:search_end]
            
            # ATTENZIONE: Cast esplicito a int puro per evitare problemi JSON
            min_speed_idx = int(window['sog_knots'].argmin() + search_start)
            sog_min = float(df['sog_knots'].iloc[min_speed_idx])

            # 2. VELOCITÀ DI INGRESSO (Target Pulito)
            target_start = max(0, i - 10)
            target_end = max(0, i - 4)
            window_in = df['sog_knots'].iloc[target_start:target_end]
            sog_in = float(window_in.median()) if len(window_in) > 0 else sog_min
            
            # 3. VELOCITÀ DI USCITA (12s dopo il minimo)
            out_idx = min(len(df)-1, min_speed_idx + 12)
            sog_out = float(df['sog_knots'].iloc[out_idx])

            # 4. CALCOLO TTR, DURATA E VELOCITÀ TARGET
            sog_lost = float(sog_in - sog_min)
            recovery_time_sec = None
            total_duration_sec = None
            target_speed_threshold = sog_in 
            
            # Punto di inizio manovra: 5 secondi prima del cambio mura (inizio perdita velocità)
            entry_idx = int(max(0, i - 5))
            descent_time = int(min_speed_idx - entry_idx) # Tempo impiegato per toccare il fondo
            
            if sog_lost <= 2.0 or sog_in < 5.0:
                # Manovra talmente pulita (o barca ferma) che il recupero è nullo
                recovery_time_sec = 0
                total_duration_sec = descent_time
            else:
                target_speed_threshold = sog_min + (sog_lost * 0.50)
                max_search_idx = min(len(df) - 1, min_speed_idx + 90)
                
                post_sog_array = df['sog_knots'].iloc[min_speed_idx : max_search_idx].values
                max_reached = float(post_sog_array.max()) if len(post_sog_array) > 0 else 0.0
                
                recovery_points = np.where(post_sog_array >= target_speed_threshold)[0]
                
                if len(recovery_points) > 0:
                    recovery_time_sec = int(recovery_points[0])
                    # CAST esplicito a int puro: Durata totale = (Discesa) + (Risalita)
                    total_duration_sec = int(descent_time + recovery_time_sec)
                else:
                    recovery_time_sec = f"Max:{max_reached:.1f}/Thr:{target_speed_threshold:.1f}"
                    total_duration_sec = "Fail"
            # ---------------------------------------------

            current_dist = float(df['cum_dist_nm'].iloc[i])
            leg_distance = current_dist - last_man_dist
            last_man_dist = current_dist
            
            timestamp_str = idx_timestamp.isoformat() if hasattr(idx_timestamp, 'isoformat') else str(idx_timestamp)
            if 'T' not in timestamp_str:
                timestamp_str = timestamp_str.replace(' ', 'T')
            
            maneuvers.append({
                'maneuverId': f"#{len(maneuvers)+1}",
                'timestamp': timestamp_str,
                'type': m_type,
                'twd_at_maneuver': round(float(twd_series.iloc[i]), 1),
                'sog_in': round(sog_in, 2),
                'sog_min': round(sog_min, 2),
                'sog_out': round(sog_out, 2),
                'delta_v': round(sog_out - sog_in, 2),
                'leg_distance_nm': round(leg_distance, 3),
                'recovery_time_s': recovery_time_sec,
                'duration_s': total_duration_sec,
                'ttr_target_sog': round(target_speed_threshold, 1) 
            })
            last_man_idx = i

        return maneuvers