import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import it from './locales/it.json';
import en from './locales/en.json';

// Configurazione i18n: italiano default, inglese come alternativa.
// La scelta utente viene persistita in localStorage (chiave varea_language)
// cosi' il refresh non riporta la lingua a quella del browser.
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      it: { translation: it },
      en: { translation: en },
    },
    fallbackLng: 'it',
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'varea_language',
    },
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
