import numpy as np
import pandas as pd
from typing import Optional

class WindEstimator:
    """
    Motore Euristico per il calcolo della True Wind Direction (TWD) locale.
    Sfrutta la statistica circolare sul Course Over Ground (COG) per trovare 
    la bisettrice dei bordi di navigazione.
    """
    
    def __init__(self, min_sog_knots: float = 4.0):
        # Sotto questa velocità si assume che la barca sia in manovra o ferma
        self.min_sog = min_sog_knots

    def estimate_twd(self, df: pd.DataFrame, api_twd: Optional[float] = None) -> float:
        """
        Calcola la TWD analizzando la distribuzione del COG.
        """
        # 1. Maschera vettoriale: teniamo solo i record in cui la barca naviga in modo stabile
        valid_cog = df.loc[df['sog_knots'] > self.min_sog, 'cog_deg'].dropna()
        
        if valid_cog.empty:
            return api_twd if api_twd is not None else 0.0

        # 2. Istogramma a 360 gradi per trovare i due bordi dominanti
        hist, _ = np.histogram(valid_cog, bins=360, range=(0, 360))
        
        # Smoothing circolare con media mobile
        window = np.ones(5) / 5
        tiled_hist = np.tile(hist, 3)
        smoothed_hist = np.convolve(tiled_hist, window, mode='same')[360:720]
        
        # Estrazione del Primo Picco
        peak1 = int(np.argmax(smoothed_hist))
        
        # Escludiamo un range attorno al primo picco
        mask = np.ones(360, dtype=bool)
        for i in range(-45, 46):
            mask[(peak1 + i) % 360] = False
        
        # Estrazione del Secondo Picco
        masked_hist = smoothed_hist * mask
        peak2 = int(np.argmax(masked_hist))
        
        # 3. Verifica euristica
        delta_angle = min((peak1 - peak2) % 360, (peak2 - peak1) % 360)
        
        if delta_angle < 10: 
            return api_twd if api_twd is not None else 0.0

        # 4. Calcolo Vettoriale della Bisettrice
        p1_rad = np.radians(peak1)
        p2_rad = np.radians(peak2)
        
        x_sum = np.sin(p1_rad) + np.sin(p2_rad)
        y_sum = np.cos(p1_rad) + np.cos(p2_rad)
        
        bisector_deg = np.degrees(np.arctan2(x_sum, y_sum)) % 360
        
        # 5. Disambiguazione Bolina vs Poppa
        if api_twd is not None:
            opposite_deg = (bisector_deg + 180) % 360
            diff1 = min(abs(bisector_deg - api_twd), 360 - abs(bisector_deg - api_twd))
            diff2 = min(abs(opposite_deg - api_twd), 360 - abs(opposite_deg - api_twd))
            
            if diff2 < diff1:
                bisector_deg = opposite_deg
        
        return round(bisector_deg, 1)