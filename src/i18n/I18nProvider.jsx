import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { translate } from './translate.js';
import { loadDevicePreferences, saveDevicePreference } from '../app/preferences.js';

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [language, setLanguageState] = useState(() => loadDevicePreferences().language);

  const setLanguage = useCallback((next) => {
    setLanguageState(next);
    saveDevicePreference('language', next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo(() => ({
    language,
    setLanguage,
    t: (text) => translate(text, language)
  }), [language, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
