import numpy as np
import pandas as pd
from typing import List, Dict, Any

class ManeuverAnalyzer:
    """
    Analizza la cinematica per taggare le andature e calcolare le metriche 
    di efficienza (Delta V, TTR Dinamico al 50% e Durata Totale).
    """
    
    def __init__(self, min_leg_time: int = 15):
        self.min_leg_time = min_leg_time 

    @staticmethod
    def angular_diff(a, b):
        return (a - b + 180) % 360 - 180

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
        df['mure'] = np.where(df['twa_signed'] >= 0, 1, -1)
        df['cambio_mure'] = df['mure'].diff().fillna(0) != 0

        change_indices = df.index[df['cambio_mure']].tolist()
        
        last_man_idx = 0
        last_man_dist = float(df['cum_dist_nm'].iloc[0])

        for idx_timestamp in change_indices:
            i = df.index.get_loc(idx_timestamp)
            
            if i - last_man_idx < self.min_leg_time:
                continue
                
            twa_momentaneo = abs(df['twa_signed'].iloc[i-1])
            m_type = "Virata" if twa_momentaneo < 90 else "Strambata"
            
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