import pandas as pd
import numpy as np
from fitparse import FitFile, FitParseError
from typing import Optional
from pathlib import Path

class TelemetryIngestor:
    """
    Gestisce la lettura, decodifica e pulizia dei dati telemetrici da file .FIT e .CSV.
    Implementa le logiche di data masking per outlier e standardizza la time-series a 1 Hz.
    """
    
    # Costanti fisiche e soglie
    SEMICIRCLES_TO_DEGREES = 180.0 / (2**31)
    MS_TO_KNOTS = 1.94384
    MAX_SOG_KNOTS = 50.0       
    MAX_ACCEL_KTS_S = 15.0     

    def __init__(self, file_path: str | Path):
        self.file_path = Path(file_path)
    
    def process(self) -> pd.DataFrame:
        """
        Esegue il flusso completo: caricamento, estrazione, pulizia e resampling.
        Gestisce dinamicamente sia file .FIT che .CSV.
        """
        # Selettore dinamico del parser in base all'estensione
        if self.file_path.suffix.lower() == '.csv':
            df = self._extract_csv_data()
        else:
            raw_records = self._extract_fit_data()
            df = pd.DataFrame(raw_records)
        
        if df.empty:
            raise ValueError("Il file non contiene record GPS validi.")

        # Imposta l'indice temporale e ordina
        df.set_index('timestamp', inplace=True)
        df.sort_index(inplace=True)
        
        # 1. Resampling a 1 Hz per garantire la continuità temporale
        df = df.resample('1s').mean()
        
        # 2. Applicazione del Data Masking
        df = self._apply_data_masking(df)
        
        # 3. Smoothing (Media mobile a 3 secondi sulla SOG)
        df['sog_knots'] = df['sog_knots'].rolling(window=3, min_periods=1, center=True).mean()
        
        return df

    def _extract_csv_data(self) -> pd.DataFrame:
        """Legge direttamente un file CSV formattato per il testing."""
        df = pd.read_csv(self.file_path)
        df['timestamp'] = pd.to_datetime(df['timestamp'])
        return df

    def _extract_fit_data(self) -> list[dict]:
        """Estrae i record dal file binario gestendo le conversioni di base."""
        try:
            fitfile = FitFile(str(self.file_path))
        except FitParseError as e:
            raise ValueError(f"File .FIT corrotto o non leggibile: {e}")

        records = []
        for record in fitfile.get_messages('record'):
            data = {}
            for data_data in record:
                data[data_data.name] = data_data.value
            
            if 'position_lat' in data and 'position_long' in data and 'timestamp' in data:
                lat = data['position_lat'] * self.SEMICIRCLES_TO_DEGREES if data['position_lat'] else np.nan
                lon = data['position_long'] * self.SEMICIRCLES_TO_DEGREES if data['position_long'] else np.nan
                speed_ms = data.get('enhanced_speed', data.get('speed', 0.0))
                sog = speed_ms * self.MS_TO_KNOTS if speed_ms is not None else 0.0
                cog = data.get('enhanced_heading', data.get('heading', np.nan))

                records.append({
                    'timestamp': data['timestamp'],
                    'lat': lat,
                    'lon': lon,
                    'sog_knots': sog,
                    'cog_deg': cog
                })
        return records

    def _apply_data_masking(self, df: pd.DataFrame) -> pd.DataFrame:
        """Identifica gli outlier e li sostituisce con NaN."""
        delta_v = df['sog_knots'].diff()
        delta_t = df.index.to_series().diff().dt.total_seconds()
        delta_t = delta_t.replace(0, np.nan) 
        accelerations = delta_v / delta_t
        
        mask_sog_outlier = df['sog_knots'] > self.MAX_SOG_KNOTS
        mask_acc_outlier = accelerations.abs() > self.MAX_ACCEL_KTS_S
        
        invalid_rows = mask_sog_outlier | mask_acc_outlier
        df.loc[invalid_rows, ['sog_knots', 'cog_deg', 'lat', 'lon']] = np.nan
        
        return df