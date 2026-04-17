// Tipi condivisi per il motore di telemetria. Questi shape rispecchiano
// la risposta JSON di FastAPI (api.py) e sono consumati dai componenti
// React. Tenere sincronizzati se il backend cambia il contratto.

export interface TrackPoint {
  timestamp: string;
  lat: number;
  lon: number;
  sog_knots: number;
  twa?: number;
  andatura?: string;
  cog_deg?: number;
}

export interface HighResPoint extends TrackPoint {
  cog_deg: number;
}

export interface Maneuver {
  timestamp: string;
  type: string;
  sog_in?: number;
  sog_min?: number;
  sog_out?: number;
  delta_v?: number;
  recovery_time_s?: number;
  ttr_target_sog?: number;
  maneuverId?: string;
  legId?: string;
  leg_distance_nm?: number;
}

export interface SessionInfo {
  file_name: string;
  start_time: string;
  duration_seconds: number;
  distance_nm: number;
  sog_max_kts: number;
  sog_avg_kts: number;
}

export interface EnvironmentInfo {
  api_twd_deg: number | null;
  computed_twd_deg: number;
  is_estimated: boolean;
}

export interface AnalyzeResponse {
  session_info: SessionInfo;
  environment: EnvironmentInfo;
  track_data: TrackPoint[];
  high_res_track: HighResPoint[];
  maneuvers: Maneuver[];
}

export type SessionStatus = 'loading' | 'ready' | 'error';

// Unità atomica del sistema multi-atleta. Un caricamento singolo produce
// un array di lunghezza 1 e il comportamento resta identico al passato.
export interface SessionData {
  id: string;
  fileName: string;
  label: string;
  color: string;
  visible: boolean;
  status: SessionStatus;
  error?: string;
  sessionInfo?: SessionInfo;
  environment?: EnvironmentInfo;
  trackData?: TrackPoint[];
  highResTrack?: HighResPoint[];
  maneuvers?: Maneuver[];
}
