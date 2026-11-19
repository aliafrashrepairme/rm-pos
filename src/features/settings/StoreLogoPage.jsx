import { useState } from 'react';
import { api } from '../../api.js';
import { refreshStoreLogo, useStoreLogo } from '../../app/storeLogo.js';
import logoAsset from '../../assets/logo.jpg';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 1024 * 1024;

// The Owner's logo replaces the built-in one in the sidebar, on the sign-in screen and on printed bills.
export default function StoreLogoPage() {
  const { t } = useI18n();
  const toast = useToast();
  const logo = useStoreLogo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function change(action, done) {
    setError('');
    setBusy(true);
    try {
      await action();
      await refreshStoreLogo();
      toast(t(done));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  function choose(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!TYPES.includes(file.type) || file.size > MAX_BYTES) {
      setError('Choose a JPG, PNG or WebP image under 1 MB.');
      return;
    }
    change(() => api('/api/logo', { method: 'PUT', headers: { 'Content-Type': file.type }, body: file }), 'Logo saved.');
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Store logo')}</h1>
          <p>{t('Shown in the menu, on the sign-in screen and on printed bills.')}</p>
        </div>
      </div>
      <div className="card">
        <div className="logo-preview">
          <img src={logo || logoAsset} alt={t('Store logo')} />
        </div>
        <p className="sub">{logo ? t('Your logo is in use.') : t('The built-in logo is in use.')} {t('Choose a JPG, PNG or WebP image under 1 MB.')}</p>
        {error && <p className="form-error" role="alert">{t(error)}</p>}
        <div className="logo-actions">
          <label className={`btn btn-primary ${busy ? 'disabled' : ''}`}>
            ⇧ {t('Upload logo')}
            <input type="file" accept={TYPES.join(',')} hidden disabled={busy} onChange={choose} />
          </label>
          {logo && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => change(() => api('/api/logo', { method: 'DELETE' }), 'Logo removed.')}>{t('Use the built-in logo')}</button>}
        </div>
      </div>
    </>
  );
}
