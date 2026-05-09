import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Inizializza i18n prima del render: i componenti che usano useTranslation
// hanno bisogno dell'istanza pronta al primo paint, altrimenti renderebbero
// in fallback statico per un frame.
import './i18n'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
