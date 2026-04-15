import requests
import pandas as pd
from datetime import datetime
from typing import Optional, Any
from .cache_manager import JSONCacheManager

class StormglassClient:
    """
    Client per recuperare dati meteo-marini da Stormglass.io.
    Parametri richiesti dal PRD: TWS, TWD, Correnti, Onde.
    """
    BASE_URL = "https://api.stormglass.io/v2"
    PARAMS = [
        'windSpeed', 'windDirection',     # TWS e TWD
        'currentSpeed', 'currentDirection', # Correnti
        'waveHeight', 'waveDirection'      # Onde
    ]

    def __init__(self, api_key: str, cache_manager: Optional[JSONCacheManager] = None):
        self.api_key = api_key
        self.cache = cache_manager or JSONCacheManager()

    def fetch_weather_for_session(self, df: pd.DataFrame) -> dict[str, Any]:
        """Estrae metadati dal DataFrame e interroga l'API o la cache."""
        avg_lat = df['lat'].mean()
        avg_lon = df['lon'].mean()
        start_time = df.index.min()
        end_time = df.index.max()
        
        cache_key = self.cache.generate_key(avg_lat, avg_lon, start_time.strftime('%Y-%m-%d'))
        
        cached_data = self.cache.get(cache_key)
        if cached_data:
            return cached_data

        headers = {'Authorization': self.api_key}
        params = {
            'lat': avg_lat,
            'lng': avg_lon,
            'params': ','.join(self.PARAMS),
            'start': start_time.timestamp(),
            'end': end_time.timestamp(),
            'source': 'sg'
        }

        try:
            response = requests.get(f"{self.BASE_URL}/weather/point", params=params, headers=headers)
            response.raise_for_status()
            data = response.json()
            
            self.cache.set(cache_key, data)
            return data
            
        except requests.exceptions.RequestException as e:
            raise ConnectionError(f"Errore durante la chiamata a Stormglass: {e}")

    @staticmethod
    def parse_to_dataframe(api_response: dict) -> pd.DataFrame:
        hours = api_response.get('hours', [])
        records = []
        for h in hours:
            records.append({
                'timestamp': pd.to_datetime(h['time']),
                'tws_ms': h.get('windSpeed', {}).get('sg'),
                'twd_deg': h.get('windDirection', {}).get('sg'),
                'cur_speed_ms': h.get('currentSpeed', {}).get('sg'),
                'cur_dir_deg': h.get('currentDirection', {}).get('sg')
            })
        
        weather_df = pd.DataFrame(records).set_index('timestamp')
        return weather_df