import streamlit as st
import pandas as pd
import numpy as np
import plotly.express as px
import tempfile
import os
from dotenv import load_dotenv 
from pathlib import Path

# --- Import Nuovi per fpdf2 (Generazione PDF) ---
from fpdf import FPDF
from fpdf.enums import XPos, YPos

# --- Import dei moduli del nostro Core Engine ---
from src.environment.stormglass_api import StormglassClient 
from src.ingestion.fit_parser import TelemetryIngestor
from src.heuristics.wind_vectors import WindEstimator
from src.heuristics.maneuvers import ManeuverAnalyzer

# --- Caricamento Variabili d'Ambiente (.env) ---
load_dotenv(override=True)      

# ==========================================
# CONFIGURAZIONE PAGINA E FUNZIONI CORE
# ==========================================

st.set_page_config(
    page_title="STA Dashboard",
    page_icon="⛵",
    layout="wide"
)

# Usiamo st.cache_data per non ricalcolare tutto a ogni interazione sulla mappa
@st.cache_data(show_spinner=False)
def process_uploaded_file(file_bytes: bytes, file_name: str):
    """
    Salva il file temporaneamente, lo passa al Core Engine e restituisce i risultati.
    """
    suffix = Path(file_name).suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
        tmp_file.write(file_bytes)
        tmp_path = tmp_file.name

    try:
        # 1. Ingestione Dati
        ingestor = TelemetryIngestor(tmp_path)
        df = ingestor.process()
        
        # --- FIX GARMIN: Calcolo vettoriale del COG se mancante o a zero ---
        if 'cog_deg' not in df.columns or df['cog_deg'].isna().all() or (df['cog_deg'] == 0).all():
            # Calcoliamo la rotta punto per punto usando la trigonometria sferica
            lat1 = np.radians(df['lat'].shift(1))
            lat2 = np.radians(df['lat'])
            dlon = np.radians(df['lon'] - df['lon'].shift(1))
            
            y = np.sin(dlon) * np.cos(lat2)
            x = np.cos(lat1) * np.sin(lat2) - np.sin(lat1) * np.cos(lat2) * np.cos(dlon)
            
            # Convertiamo in gradi e assicuriamo il range 0-360
            df['cog_deg'] = np.degrees(np.arctan2(y, x)) % 360
            
            # Riempiamo i buchi iniziali copiando il valore successivo
            df['cog_deg'] = df['cog_deg'].bfill().ffill()
        
        # 2. Ambiente & Motore Euristico (Calcolo Vento)
        api_twd = None
        api_key = os.getenv('STORMGLASS_API_KEY')
        
        print(f"[DEBUG] Sto cercando la chiave API. Trovata: {'SI' if api_key else 'NO'}")
        
        if api_key:
            try:
                print("[DEBUG] Tento la chiamata a Stormglass...")
                sg_client = StormglassClient(api_key=api_key)
                weather_data = sg_client.fetch_weather_for_session(df)
                weather_df = sg_client.parse_to_dataframe(weather_data)
                
                if not weather_df.empty:
                    api_twd = weather_df['twd_deg'].mean()
                    print(f"[DEBUG] Successo! TWD da Stormglass: {api_twd}°")
            except Exception as e:
                print(f"⚠️ [ERRORE STORMGLASS]: {e}")
                
        # --- IL MOTORE VETTORIALE ---
        wind_estimator = WindEstimator()
        computed_twd = wind_estimator.estimate_twd(df, api_twd=api_twd)
        print(f"[DEBUG] TWD Finale Calcolato dal Motore: {computed_twd}°")
        
        # 3. Analisi Manovre
        analyzer = ManeuverAnalyzer()
        df = analyzer.tag_points_of_sail(df, computed_twd)
        maneuvers = analyzer.detect_maneuvers(df, computed_twd)
        
        # 4. Compilazione Report
        report = {
            "session_info": {
                "file_name": file_name,
                "duration_seconds": len(df),
                "sog_max_kts": round(df['sog_knots'].max(), 2),
                "sog_avg_kts": round(df['sog_knots'].mean(), 2)
            },
            "environment": {
                "computed_twd_deg": computed_twd
            },
            "maneuvers": maneuvers
        }
        
        os.remove(tmp_path)
        return df, report

    except Exception as e:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise e

# ==========================================
# INTERFACCIA UTENTE (FRONTEND)
# ==========================================

# --- UI: Intestazione ---
st.title("⛵ Sail & Windsurf Telemetry")
st.markdown("Trasforma i dati grezzi del tuo GPS in analisi da regata.")

# --- UI: Barra Laterale (Sidebar) ---
with st.sidebar:
    st.header("📂 Inizia da qui")
    uploaded_file = st.file_uploader("Carica una sessione (.FIT o .CSV)", type=['fit', 'csv'])
    
    with st.expander("🛠️ Impostazioni Avanzate"):
        st.markdown("<small>Regola la sensibilità dell'algoritmo di analisi.</small>", unsafe_allow_html=True)
        v_min_analysis = st.number_input(
            "Velocità di taglio (kts)", 
            value=2.0, 
            help="Sotto questa velocità il software considera l'atleta fermo e scarta i dati per pulire il calcolo del vento."
        )
        wind_margin = st.slider(
            "Tolleranza Vento (°)", 
            5, 30, 15,
            help="Gradi di flessibilità concessi all'algoritmo per incrociare i bordi opposti."
        )
        
        has_api = os.getenv('STORMGLASS_API_KEY') is not None
        st.info(f"Meteo Satellitare: **{'Attivo 🟢' if has_api else 'Assente 🔴'}**")

# --- UI: Onboarding (Cosa succede se non c'è il file) ---
if uploaded_file is None:
    st.markdown("---")
    st.subheader("👋 Benvenuto nella tua Dashboard Analitica")
    st.write("Questa app analizza la cinematica della tua tavola o barca per aiutarti a ottimizzare le performance, il trim e la tecnica.")
    
    st.markdown("### Cosa scoprirai caricando la tua traccia?")
    col_intro1, col_intro2, col_intro3 = st.columns(3)
    
    with col_intro1:
        st.info("🌬️ **Analisi del Vento Reale**\n\nIl motore vettoriale deduce la direzione del vento (TWD) analizzando la tua rotta, validandola con i dati satellitari storici.")
    with col_intro2:
        st.info("🚀 **Efficienza in Planata**\n\nIl grafico Polare e la VMG ti mostrano esattamente i tuoi angoli ottimali e se hai asimmetrie tra le mure a dritta e sinistra.")
    with col_intro3:
        st.info("🔄 **Diagnostica Manovre**\n\nScopri quante strambate chiudi in pieno foil/planata e calcola la percentuale di velocità persa in ogni transizione.")
        
    st.markdown("👈 **Usa la barra laterale per caricare il tuo file Garmin (.FIT) e avviare l'analisi.**")
    st.stop() # Ferma l'esecuzione finché non c'è il file

# ==========================================
# ELABORAZIONE E RENDERING GRAFICI
# ==========================================

# Flusso di Controllo: Elaborazione
with st.spinner(f"Sto elaborando la fisica della sessione '{uploaded_file.name}'..."):
    try:
        # Estraiamo i byte e il nome per passarli alla funzione in cache
        df, report = process_uploaded_file(uploaded_file.getvalue(), uploaded_file.name)
    except Exception as e:
        st.error(f"❌ Errore durante l'elaborazione: {e}")
        st.stop()

# Estrazione variabili di comodo dal report
info = report.get("session_info", {})
env = report.get("environment", {})
maneuvers = report.get("maneuvers", [])
twd = env.get('computed_twd_deg', 'N/D')

# --- Sezione 1: KPI (Key Performance Indicators) ---
st.subheader("📊 Riepilogo Sessione")

# Aggiungiamo i Tooltips (help) alle metriche per spiegare il gergo
col1, col2, col3, col4 = st.columns(4)

with col1:
    st.metric(
        label="Velocità Max", 
        value=f"{info.get('sog_max_kts', 0)} kts",
        help="SOG (Speed Over Ground): La velocità massima raggiunta rispetto al fondale."
    )
with col2:
    st.metric(
        label="Velocità Media", 
        value=f"{info.get('sog_avg_kts', 0)} kts",
        help="Media calcolata scartando i momenti in cui la velocità scende sotto il limite di taglio."
    )
with col3:
    st.metric(
        label="Vento Calcolato", 
        value=f"{twd}°",
        help="TWD (True Wind Direction): L'angolo geografico esatto da cui soffiava il vento durante la sessione."
    )
with col4:
    st.metric(
        label="Manovre Valide", 
        value=str(len(maneuvers)),
        help="Numero totale di virate e strambate in cui è stato registrato un chiaro ingresso e uscita."
    )

st.divider()

# --- Sezione 2: Mappa Interattiva ---
st.subheader("🗺️ Traccia GPS")

fig = px.scatter_map(
    df.reset_index(), 
    lat="lat", 
    lon="lon", 
    color="sog_knots",
    hover_name="timestamp",
    hover_data={"sog_knots": ":.2f", "cog_deg": ":.0f", "andatura": True, "lat": False, "lon": False},
    color_continuous_scale=px.colors.sequential.Plasma,
    zoom=17, 
    map_style="carto-positron",
    title=f"Rotta di navigazione - {info.get('file_name')}"
)

fig.update_layout(margin={"r":0,"t":40,"l":0,"b":0})
st.plotly_chart(fig, width='stretch')

# --- Sezione 3: Tabella Manovre (Coach Analysis) ---
st.subheader("🔄 Analisi Manovre Avanzata")

if maneuvers:
    df_maneuvers = pd.DataFrame(maneuvers)
    
    # UI: Slider per far decidere all'utente la soglia di planata/volo
    st.markdown("Imposta la velocità minima sotto la quale consideri di aver perso la planata o il foil:")
    foil_threshold = st.slider("Soglia di Volo/Planata (Nodi)", min_value=5.0, max_value=20.0, value=12.0, step=0.5)

    # Nuova Metrica: Esito (Fly vs Touchdown)
    df_maneuvers['esito'] = df_maneuvers['sog_min'].apply(lambda x: '🚀 Fly / Planing' if x >= foil_threshold else '💦 Touchdown')
    
    # Nuova Metrica: Efficienza (Mantenimento della velocità in percentuale)
    df_maneuvers['efficienza_%'] = np.where(
        df_maneuvers['sog_in'] > 0, 
        (df_maneuvers['sog_min'] / df_maneuvers['sog_in'] * 100), 
        0
    )
    
    # Mostriamo la tabella arricchita
    st.dataframe(
        df_maneuvers, 
        width='stretch',
        column_config={
            "timestamp": st.column_config.DatetimeColumn("Orario", format="HH:mm:ss"),
            "type": "Manovra",
            "esito": "Esito",
            "efficienza_%": st.column_config.ProgressColumn(
                "Mantenimento Vel.",
                format="%f%%",
                min_value=0,
                max_value=100,
            ),
            "sog_in": st.column_config.NumberColumn("Ingresso (kts)", format="%.1f"),
            "sog_min": st.column_config.NumberColumn("V. Minima (kts)", format="%.1f")
        },
        column_order=["timestamp", "type", "esito", "efficienza_%", "sog_in", "sog_min"]
    )
    
    # Coach Summary (Riepilogo)
    fly_count = (df_maneuvers['esito'] == '🚀 Fly / Planing').sum()
    tot_maneuvers = len(df_maneuvers)
    win_rate = int(fly_count / tot_maneuvers * 100) if tot_maneuvers > 0 else 0
    
    if win_rate > 70:
        st.success(f"**Coach Summary:** Ottimo lavoro! Hai chiuso il **{win_rate}%** delle manovre in planata ({fly_count} su {tot_maneuvers}).")
    elif win_rate > 30:
        st.warning(f"**Coach Summary:** Sessione discreta. Hai chiuso il **{win_rate}%** delle manovre in planata ({fly_count} su {tot_maneuvers}).")
    else:
        st.error(f"**Coach Summary:** Giornata dura eh? Solo il **{win_rate}%** delle manovre chiuse in planata ({fly_count} su {tot_maneuvers}).")

else:
    st.info("Nessuna manovra registrata in questa sessione.")

# --- Sezione 4: Performance e Diagramma Polare ---
st.divider()
st.subheader("🎯 Analisi Performance (Polari & VMG)")

if twd != 'N/D' and not df.empty:
    # PULIZIA DATI REALI: Rimuoviamo i momenti in cui il GPS ha perso la direzione
    df_clean = df.dropna(subset=['cog_deg', 'sog_knots']).copy()
    
    # Usiamo df_clean per i calcoli vettoriali
    df_clean['twa'] = (df_clean['cog_deg'] - twd) % 360
    df_clean['vmg'] = df_clean['sog_knots'] * np.cos(np.radians(df_clean['twa']))
    
    col_polar, col_vmg = st.columns(2)
    
    with col_polar:
        st.markdown("**Diagramma Polare (SOG vs TWA)**")
        st.info("💡 Lo zero in alto rappresenta la direzione da cui soffia il vento.")
        
        fig_polar = px.scatter_polar(
            df_clean.reset_index(), 
            r="sog_knots",      
            theta="twa",        
            color="andatura",   
            color_discrete_map={
                'Bolina': '#EF553B', 
                'Traverso': '#00CC96', 
                'Lasco/Poppa': '#636EFA', 
                'Sconosciuta': '#B6E880'
            },
            hover_name="timestamp",
            hover_data={"sog_knots": ":.2f", "vmg": ":.2f", "twa": ":.0f"}
        )
        
        fig_polar.update_layout(
            polar=dict(angularaxis=dict(direction="clockwise", rotation=90)),
            margin={"r":20,"t":20,"l":20,"b":20}
        )
        st.plotly_chart(fig_polar, width='stretch')
        
    with col_vmg:
        st.markdown("**Analisi VMG (Velocity Made Good)**")
        st.info("💡 Valori positivi: stai risalendo il vento (Bolina). Negativi: stai scendendo (Poppa).")
        
        max_vmg_upwind = df_clean['vmg'].max()
        max_vmg_downwind = df_clean['vmg'].min()
        
        up_str = f"{max_vmg_upwind:.2f}" if not pd.isna(max_vmg_upwind) else "0.00"
        dn_str = f"{abs(max_vmg_downwind):.2f}" if not pd.isna(max_vmg_downwind) else "0.00"
        
        st.metric("Miglior VMG Bolina", f"{up_str} kts")
        st.metric("Miglior VMG Poppa", f"{dn_str} kts")
        
        fig_hist = px.histogram(
            df_clean, 
            x="sog_knots", 
            nbins=30,
            title="Distribuzione delle Velocità",
            labels={'sog_knots': 'Velocità (Nodi)'},
            color_discrete_sequence=['#AB63FA']
        )
        st.plotly_chart(fig_hist, width='stretch')

else:
    st.warning("Calcolo del vento non disponibile. Impossibile generare le Polari.")

# --- Sezione 5: Analisi per Bordi (Leg Analysis) ---
st.divider()
st.subheader("⛵ Analisi per Bordi (Leg Analysis)")

if twd != 'N/D' and not df.empty and 'df_clean' in locals():
    # 1. Definiamo le Mure (Tack) in base all'angolo del vento (TWA)
    df_clean['mure'] = np.where(df_clean['twa'] <= 180, 'Dritta', 'Sinistra')
    
    # 2. Creiamo un ID univoco per ogni bordo identificando i cambi di mure
    df_clean['bordo_id'] = (df_clean['mure'] != df_clean['mure'].shift(1)).cumsum()
    
    # 3. Raggruppiamo i dati per calcolare le statistiche di ogni bordo
    legs_summary = df_clean.groupby('bordo_id').agg(
        mure=('mure', 'first'),
        andatura=('andatura', lambda x: x.mode()[0] if not x.mode().empty else 'N/D'),
        durata_sec=('sog_knots', 'count'), 
        sog_avg=('sog_knots', 'mean'),
        sog_max=('sog_knots', 'max'),
        vmg_avg=('vmg', 'mean')
    ).reset_index()
    
    # 4. Filtriamo il "rumore": ignoriamo i bordi che durano meno di 15 secondi
    legs_summary = legs_summary[legs_summary['durata_sec'] >= 15].copy()
    
    # Rinominiamo le colonne per una UI professionale
    legs_summary = legs_summary.rename(columns={
        'bordo_id': 'Bordo #',
        'mure': 'Mure',
        'andatura': 'Andatura',
        'durata_sec': 'Durata (s)',
        'sog_avg': 'Vel. Media (kts)',
        'sog_max': 'Vel. Max (kts)',
        'vmg_avg': 'VMG Media (kts)'
    })
    
    col_table, col_chart = st.columns([1.5, 1])
    
    with col_table:
        st.markdown("**📊 Dettaglio Singoli Bordi**")
        st.dataframe(
            legs_summary, 
            hide_index=True, 
            width='stretch',
            column_config={
                "Vel. Media (kts)": st.column_config.NumberColumn(format="%.2f"),
                "Vel. Max (kts)": st.column_config.NumberColumn(format="%.2f"),
                "VMG Media (kts)": st.column_config.NumberColumn(format="%.2f")
            }
        )
        
    with col_chart:
        st.markdown("**⚖️ Bilanciamento (Dritta vs Sinistra)**")
        st.info("Mostra eventuali asimmetrie nel setup o nella tecnica dell'atleta.")
        
        legs_summary['VMG Assoluta'] = legs_summary['VMG Media (kts)'].abs()
        
        fig_symmetry = px.bar(
            legs_summary.groupby('Mure')['VMG Assoluta'].mean().reset_index(),
            x='Mure',
            y='VMG Assoluta',
            color='Mure',
            color_discrete_map={'Dritta': '#00CC96', 'Sinistra': '#EF553B'},
            labels={'VMG Assoluta': 'VMG Media Assoluta (kts)'}
        )
        fig_symmetry.update_layout(margin={"r":0,"t":20,"l":0,"b":0}, showlegend=False)
        st.plotly_chart(fig_symmetry, width='stretch')

# --- Sezione 6: Esportazione Report PDF (Coach Tools) ---
st.divider()
st.subheader("📋 Generatore Report Professionale")

# Campo Note dell'Allenatore
coach_notes = st.text_area(
    "Note e Osservazioni del Coach:", 
    placeholder="Inserisci qui i consigli tecnici per l'atleta (es. 'Migliorare l'angolo di uscita dalla strambata', 'Assetto troppo appruato in bolina')...",
    height=150
)

# Logica di generazione PDF
def generate_pdf(report_data, notes):
    pdf = FPDF()
    pdf.add_page()
    
    # Header
    pdf.set_font("helvetica", "B", 20)
    pdf.cell(0, 10, "Sail & Windsurf Performance Report", new_x=XPos.LMARGIN, new_y=YPos.NEXT, align='C')
    pdf.ln(10)
    
    # Info Sessione
    pdf.set_font("helvetica", "B", 14)
    pdf.cell(0, 10, f"Sessione: {report_data['session_info']['file_name']}", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("helvetica", "", 11)
    pdf.cell(0, 7, f"Velocità Max: {report_data['session_info']['sog_max_kts']} kts", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.cell(0, 7, f"Velocità Media: {report_data['session_info']['sog_avg_kts']} kts", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.cell(0, 7, f"Vento Stimato (TWD): {report_data['environment']['computed_twd_deg']}°", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(5)
    
    # Note Coach
    pdf.set_fill_color(240, 240, 240)
    pdf.set_font("helvetica", "B", 12)
    pdf.cell(0, 10, "Note Tecniche del Coach:", new_x=XPos.LMARGIN, new_y=YPos.NEXT, fill=True)
    pdf.set_font("helvetica", "I", 11)
    pdf.multi_cell(0, 7, notes if notes else "Nessuna nota inserita.")
    pdf.ln(10)
    
    # Manovre
    pdf.set_font("helvetica", "B", 12)
    pdf.cell(0, 10, "Riepilogo Manovre:", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("helvetica", "", 10)
    for m in report_data['maneuvers'][:15]: # Limitiamo alle prime 15 per spazio
        pdf.cell(0, 6, f"- {m['type']} a {m['timestamp'][:19]}: Min Speed {m['sog_min']} kts (Loss: {m['delta_v']} kts)", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        
    return bytes(pdf.output())

# Pulsante di Download
if st.button("🚀 Genera e Scarica Report PDF"):
    with st.spinner("Creazione del PDF in corso..."):
        pdf_bytes = generate_pdf(report, coach_notes)
        st.download_button(
            label="⬇️ Scarica Ora il Report",
            data=pdf_bytes,
            file_name=f"Report_{info.get('file_name', 'sessione')}.pdf",
            mime="application/pdf"
        )
        st.success("Report generato con successo!")