import numpy as np
import pandas as pd
from typing import List, Dict, Any

class ManeuverAnalyzer:
    """
    Analizza la cinematica della sessione per taggare le andature 
    e calcolare le metriche di efficienza delle manovre (Delta V).
    """
    
    def __init__(self, delta_t_in: int = 3, delta_t_out: int = 5, min_cog_turn: float = 60.0):
        self.dt_in = delta_t_in
        self.dt_out = delta_t_out
        self.min_cog_turn = min_cog_turn

    @staticmethod
    def angular_diff(a: pd.Series, b: float) -> pd.Series:
        return (a - b + 180) % 360 - 180

    def tag_points_of_sail(self, df: pd.DataFrame, twd: float) -> pd.DataFrame:
        twa_abs = self.angular_diff(df['cog_deg'], twd).abs()
        
        conditions = [
            (twa_abs <= 70),                     # Bolina
            (twa_abs > 70) & (twa_abs <= 120),   # Traverso
            (twa_abs > 120)                      # Lasco/Poppa
        ]
        choices = ['Bolina', 'Traverso', 'Lasco/Poppa']
        
        df['andatura'] = np.select(conditions, choices, default='Sconosciuta')
        return df

    def detect_maneuvers(self, df: pd.DataFrame, twd: float) -> List[Dict[str, Any]]:
        maneuvers = []
        
        rad_cog = np.radians(df['cog_deg'])
        sin_diff = np.sin(rad_cog).diff(periods=8)
        cos_diff = np.cos(rad_cog).diff(periods=8)
        delta_cog = np.degrees(np.arctan2(sin_diff, cos_diff)).abs()
        
        turn_mask = (delta_cog > self.min_cog_turn) & (df['sog_knots'] > 3.0)
        turn_starts = df.index[turn_mask & ~turn_mask.shift(1).fillna(False)]
        
        last_maneuver_pos = -9999
        cooldown_seconds = 20
        
        # --- NOVITÀ: Calcolo Distanza Progressiva ---
        # Dato che la velocità è in nodi (Miglia Nautiche all'ora) e il GPS
        # registra circa 1 punto al secondo, dividiamo SOG per 3600.
        df['cum_dist_nm'] = (df['sog_knots'] / 3600).cumsum()
        
        # Il punto di partenza per calcolare la distanza della primissima manovra
        last_maneuver_dist = float(df['cum_dist_nm'].iloc[0]) if len(df) > 0 else 0.0
        
        for start_idx in turn_starts:
            start_pos = df.index.get_loc(start_idx)
            
            if start_pos < last_maneuver_pos + cooldown_seconds:
                continue
                
            last_maneuver_pos = start_pos
            
            end_pos = min(start_pos + 15, len(df) - 1)
            window_df = df.iloc[start_pos:end_pos]
            
            min_sog_idx = window_df['sog_knots'].idxmin()
            min_sog_pos = df.index.get_loc(min_sog_idx)
            
            if min_sog_pos >= self.dt_in and (min_sog_pos + self.dt_out) < len(df):
                idx_in = df.index[min_sog_pos - self.dt_in]
                idx_out = df.index[min_sog_pos + self.dt_out]
                
                sog_in = float(df.at[idx_in, 'sog_knots'])
                sog_min = float(df.at[min_sog_idx, 'sog_knots'])
                sog_out = float(df.at[idx_out, 'sog_knots'])
                
                cog_in = float(df.at[idx_in, 'cog_deg'])
                cog_out = float(df.at[idx_out, 'cog_deg'])
                
                is_tack = abs(self.angular_diff(pd.Series([(cog_in + cog_out)/2]), twd).iloc[0]) < 90
                m_type = "Virata" if is_tack else "Strambata"
                
                # --- NOVITÀ: Calcolo Distanza del Leg ---
                current_dist = float(df.at[min_sog_idx, 'cum_dist_nm'])
                leg_distance = current_dist - last_maneuver_dist
                last_maneuver_dist = current_dist  # Aggiorna il "checkpoint" per la prossima manovra
                
                maneuvers.append({
                    'timestamp': min_sog_idx.isoformat(),
                    'type': m_type,
                    'sog_in': round(sog_in, 2),
                    'sog_min': round(sog_min, 2),
                    'sog_out': round(sog_out, 2),
                    'delta_v': round(sog_out - sog_in, 2),
                    'leg_distance_nm': round(leg_distance, 3) # <-- Ora viene spedito al Frontend!
                })
                
        return maneuvers