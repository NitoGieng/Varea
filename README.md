# Varea Telemetry Analytics

Varea Telemetry Analytics è una piattaforma avanzata dedicata all'analisi delle prestazioni nella vela e, in particolare, negli sport acquatici basati su foiling (come windsurf foil e barche a vela volanti). Il sistema trasforma i dati grezzi di navigazione in metriche fruibili ad alta precisione, focalizzandosi sull'assetto di volo, l'efficienza delle manovre e il confronto diretto tra atleti.

## 🎯 Obiettivo del Progetto

Il cuore di Varea è fornire insight di livello agonistico e olimpico attraverso l'elaborazione di dati telemetrici complessi. La piattaforma risolve il problema del confronto multi-atleta consentendo di sincronizzare e sovrapporre i dati di diversi file `.FIT` utilizzando timestamp assoluti. Questo approccio rende possibile un'analisi in stile "ghosting", permettendo ad allenatori e atleti di confrontare traiettorie, velocità e reazioni nelle medesime condizioni di vento e onda.

## ✨ Funzionalità Principali

*   **Sincronizzazione Multi-Atleta (Ghosting):** Allineamento temporale assoluto dei log GPS a 1Hz provenienti da dispositivi diversi per confronti millimetrici sulle performance.
*   **Rilevamento Specifico per il Foiling ("Fly vs. Touch"):** Algoritmi in grado di identificare e quantificare il tempo trascorso in assetto di volo rispetto alle fasi di dislocamento o contatto con l'acqua.
*   **Analisi Avanzata delle Manovre:** Rilevamento automatico di virate e strambate tramite euristiche basate sull'incrocio dell'asse del vento, con conseguente assegnazione di un punteggio di efficienza per ogni manovra.
*   **Metriche di Regata:** Calcolo in tempo continuo del VMG (Velocity Made Good) e di altre metriche vettoriali fondamentali per la tattica.
*   **Integrazione Meteo:** Connessione con l'API di Stormglass per contestualizzare i dati di prestazione con le condizioni meteorologiche e del vento storiche presenti sul campo di regata.

## 🛠 Stack Tecnologico

Il progetto separa l'elaborazione intensiva dei dati dall'interfaccia utente, sfruttando le migliori tecnologie per entrambi i domini:

### Motore di Analisi dei Dati (Data Processing)
*   **Python:** Linguaggio principale per l'edge computing e la logica di backend.
*   **Pandas & NumPy:** Utilizzati pesantemente per la pulizia dei dati, le manipolazioni matriciali, l'applicazione di filtri e il calcolo vettoriale delle metriche telemetriche.

### Interfaccia Utente (Visualizzazione)
*   **React & TypeScript:** Sviluppo di una dashboard reattiva e type-safe per il caricamento dei file, l'esplorazione dei grafici e la visualizzazione interattiva delle traiettorie sincronizzate.

## ⚙️ Architettura e Flusso Dati

1.  **Acquisizione:** I dispositivi fisici a bordo degli atleti registrano i file `.FIT` contenenti dati GPS, velocità e sensori di movimento.
2.  **Parsing & Arricchimento:** Il sistema estrae la serie storica a 1Hz, correlando i dati spaziali con le letture esterne del vento tramite Stormglass API.
3.  **Motore Algoritmico:** Script Python elaborano i vettori per estrarre lo stato di volo, isolare i segmenti di manovra e calcolare i cali di efficienza (es. drop di velocità durante una strambata).
4.  **Rendering Visivo:** I dati strutturati passano al frontend React, dove grafici dinamici e mappe permettono agli allenatori di navigare letteralmente attraverso la sessione di allenamento.
