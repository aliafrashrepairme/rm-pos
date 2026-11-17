import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/prototype.css';
import './styles/app.css';
import { ToastProvider } from './components/Toast.jsx';
import { I18nProvider } from './i18n/I18nProvider.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider><ToastProvider><App /></ToastProvider></I18nProvider>
  </StrictMode>
);
