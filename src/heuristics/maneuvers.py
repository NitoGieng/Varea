import os
import numpy as np
import pandas as pd
from typing import List, Dict, Any

# Finestre di classificazione virata/strambata (secondi).
# Derivate dal lag del filtro Schmitt+dwell (~6-7s): la finestra parte a 8s
# dall'evento per campionare l'andatura stabile, non la transizione in corso.
_CLASS_WINDOW_LAG_S = 8
_CLASS_WINDOW_LEN_S = 12

# Sanity-gate fisica sul Δ-COG: un flip di mure senza reale rotazione della
# prua non e' una manovra, e' il TWD che oscilla attorno a un COG costante.
# Una virata reale ha Δcog≈70-90°, una strambata ≈80-100°. Soglia a 45°
# scarta rumore lasciando ampio margine al caso "manovra piccola in wave".
# Le finestre pre/post [i-10,i-5] e [i+5,i+10] sono 5s ciascuna a 1Hz: stanno
# fuori dal cono del turno stesso (dove il COG ruota) ma vicine abbastanza
# da campionare la direzione di rotta effettiva prima e dopo.
_COG_GATE_DEG = 45.0
_COG_PRE_LO = 10
_COG_PRE_HI = 5
_COG_POST_LO = 5
_COG_POST_HI = 10

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

            # Sanity-gate fisica: una manovra reale ruota il COG di ≥45°.
            # Un flip di mure senza rotazione del COG (Δcog piccolo) e' sempre
            # TWD che oscilla attorno a un COG stabile, non una manovra vera.
            # Senza questo gate, anche con il filtro mure blindato, un TWD
            # rumoroso a poppa piena o vicino al wrap giornaliero 350°/10°
            # puo' generare flip geometricamente corretti ma fisicamente
            # assurdi. Taglio qui prima della classificazione, che e' costosa.
            pre_cog_lo = max(0, i - _COG_PRE_LO)
            pre_cog_hi = max(0, i - _COG_PRE_HI)
            post_cog_lo = min(len(df), i + _COG_POST_LO)
            post_cog_hi = min(len(df), i + _COG_POST_HI)
            pre_cog_win = df['cog_deg'].iloc[pre_cog_lo:pre_cog_hi].to_numpy()
            post_cog_win = df['cog_deg'].iloc[post_cog_lo:post_cog_hi].to_numpy()

            # Richiedo entrambe le finestre piene: a inizio/fine sessione il
            # gate non puo' essere applicato e accetto la manovra (preserva
            # backward compat su file corti / manovre ai bordi). Una finestra
            # monca tenderebbe a sottostimare il Δcog rendendo il gate ostile.
            if len(pre_cog_win) >= 3 and len(post_cog_win) >= 3:
                pre_cog = self._circular_mean_deg(pre_cog_win)
                post_cog = self._circular_mean_deg(post_cog_win)
                delta_cog = abs(self.angular_diff(post_cog, pre_cog))
                if delta_cog < _COG_GATE_DEG:
                    if _DEBUG_CLASS:
                        print(
                            f"[maneuvers] i={i} ts={idx_timestamp} "
                            f"SCARTATA: Δcog={delta_cog:.1f}° < {_COG_GATE_DEG}° "
                            f"(pre={pre_cog:.1f}° post={post_cog:.1f}°)",
                            flush=True,
                        )
                    continue

            # Classificazione robusta: voto a maggioranza su 4 segnali
            # indipendenti (TWA pre, TWA post, andatura pre, andatura post).
            # Disaccoppia la decisione da un singolo valore di TWD che può
            # essere mal stimato localmente — con 4 segnali serve che almeno
            # 3 convergano sull'etichetta sbagliata per confondere il voto.
            pre_lo = max(0, i - _CLASS_WINDOW_LAG_S - _CLASS_WINDOW_LEN_S)
            pre_hi = max(0, i - _CLASS_WINDOW_LAG_S)
            post_lo = min(len(df), i + _CLASS_WINDOW_LAG_S)
            post_hi = min(len(df), i + _CLASS_WINDOW_LAG_S + _CLASS_WINDOW_LEN_S)

            twa_abs_series = df['twa_signed'].abs()
            andatura_series = df['andatura']
            pre_twa = twa_abs_series.iloc[pre_lo:pre_hi]
            post_twa = twa_abs_series.iloc[post_lo:post_hi]
            pre_and = andatura_series.iloc[pre_lo:pre_hi]
            post_and = andatura_series.iloc[post_lo:post_hi]

            # Firma fisica del crossing: durante una virata twa_signed attraversa
            # 0° (prua nel vento), durante una strambata attraversa ±180° (poppa
            # nel vento). Cerco il crossing in una finestra centrata sul momento
            # fisico (i - lag_filtro_schmitt ≈ i-6), allargata: [i-15, i+5].
            #
            # Non uso min/max: un solo sample spurio (glitch COG da diff GPS
            # su frame quasi fermi, o salto di interpolazione TWD) farebbe
            # scattare la firma. Conto invece quanti sample cadono nelle bande
            # 0-30° e 150-180° e richiedo ≥3 sample (3 secondi a 1Hz) perché
            # sia un vero passaggio, con ≤1 sample nella banda opposta.
            cross_lo = max(0, i - 15)
            cross_hi = min(len(df), i + 5)
            cross_window = twa_abs_series.iloc[cross_lo:cross_hi]
            cross_min = float(cross_window.min()) if len(cross_window) else float('nan')
            cross_max = float(cross_window.max()) if len(cross_window) else float('nan')
            count_near_zero = int((cross_window < 30).sum())
            count_near_pi = int((cross_window > 150).sum())

            votes: List[str] = []

            # Voti 1-2: mediana di |TWA| pre e post (soglia 90°)
            if len(pre_twa) >= 4:
                votes.append('Virata' if float(pre_twa.median()) < 90 else 'Strambata')
            if len(post_twa) >= 4:
                votes.append('Virata' if float(post_twa.median()) < 90 else 'Strambata')

            # Voti 3-4: andatura prevalente pre/post (Traverso astensione)
            for window in (pre_and, post_and):
                if len(window) == 0:
                    continue
                bolina = int((window == 'Bolina').sum())
                poppa = int((window == 'Lasco/Poppa').sum())
                if bolina > poppa:
                    votes.append('Virata')
                elif poppa > bolina:
                    votes.append('Strambata')

            # Voti 5-6: firma fisica del crossing (peso doppio, più diretta).
            # Soglia asimmetrica: la banda a 150-180° è più rumorosa della banda
            # a 0-30° per tre motivi — wrap-around di angular_diff vicino a ±180°,
            # COG-glitch quando la barca rallenta (diff GPS instabile), e
            # interpolazione TWD lineare attraverso cambio ora Stormglass.
            # Quindi:
            # - Virata: ≥1 sample a |TWA|<30° con ≤1 sample a |TWA|>150° (il
            #   singolo outlier alto è tollerato come rumore di wrap/glitch).
            # - Strambata: ≥3 sample a |TWA|>150° con ≤1 a |TWA|<30° (serve un
            #   passaggio persistente, non un glitch isolato).
            if len(cross_window) >= 5:
                if count_near_zero >= 1 and count_near_pi <= 1:
                    votes.extend(['Virata', 'Virata'])
                elif count_near_pi >= 3 and count_near_zero <= 1:
                    votes.extend(['Strambata', 'Strambata'])

            virate_n = votes.count('Virata')
            strambata_n = votes.count('Strambata')

            if virate_n > strambata_n:
                m_type = 'Virata'
            elif strambata_n > virate_n:
                m_type = 'Strambata'
            else:
                # Pareggio o nessun voto: fallback al sample immediato
                m_type = 'Virata' if abs(float(df['twa_signed'].iloc[i-1])) < 90 else 'Strambata'

            if _DEBUG_CLASS:
                pre_med = float(pre_twa.median()) if len(pre_twa) else float('nan')
                post_med = float(post_twa.median()) if len(post_twa) else float('nan')
                pre_b = int((pre_and == 'Bolina').sum())
                pre_p = int((pre_and == 'Lasco/Poppa').sum())
                post_b = int((post_and == 'Bolina').sum())
                post_p = int((post_and == 'Lasco/Poppa').sum())
                print(
                    f"[maneuvers] i={i} ts={idx_timestamp} "
                    f"twa_pre={pre_med:.1f} twa_post={post_med:.1f} "
                    f"cross_min={cross_min:.1f} cross_max={cross_max:.1f} "
                    f"n_low={count_near_zero} n_high={count_near_pi} "
                    f"and_pre=B{pre_b}/P{pre_p}/tot{len(pre_and)} "
                    f"and_post=B{post_b}/P{post_p}/tot{len(post_and)} "
                    f"votes={votes} -> {m_type}",
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