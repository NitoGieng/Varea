import json
import hashlib
from pathlib import Path
from typing import Optional, Any

class JSONCacheManager:
    """
    Gestisce il caching locale delle risposte API per ottimizzare i costi e le performance.
    La chiave di cache è basata su posizione spaziale e temporale.
    """
    def __init__(self, cache_dir: str = "data/cache"):
        self.cache_dir = Path(cache_dir)
        # Crea la cartella se non esiste
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def generate_key(self, lat: float, lon: float, date_str: str) -> str:
        """
        Genera un hash univoco basato su lat/lon arrotondati e data.
        """
        lat_round = round(lat, 1)
        lon_round = round(lon, 1)
        identifier = f"{lat_round}_{lon_round}_{date_str}"
        return hashlib.md5(identifier.encode()).hexdigest()

    def get(self, key: str) -> Optional[dict[str, Any]]:
        """Recupera i dati dalla cache se esistono."""
        cache_file = self.cache_dir / f"{key}.json"
        if cache_file.exists():
            with open(cache_file, 'r') as f:
                return json.load(f)
        return None

    def set(self, key: str, data: dict[str, Any]) -> None:
        """Salva i dati in cache."""
        cache_file = self.cache_dir / f"{key}.json"
        with open(cache_file, 'w') as f:
            json.dump(data, f, indent=4)