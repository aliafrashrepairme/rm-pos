import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { LANGUAGES } from '../../i18n/translate.js';

const RECEIPT_SWITCHES = [
  ['showTax', 'Show tax breakdown', 'Display tax separately on receipt'],
  ['showBalance', 'Show cash balance', 'Display change to give the customer'],
  ['printAfterSale', 'Print after payment', 'Prompt receipt printing after sale']
];

function Switch({ on, label, onChange }) {
  return <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export default function SettingsPage({ theme, onTheme, onLanguage }) {
  const { t, language } = useI18n();
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [store, setStore] = useState(null);
  const [footer, setFooter] = useState('');
  const [rates, setRates] = useState({});
  const [error, setError] = useState('');

  function show(next) {
    setSettings(next);
    setStore({ storeName: next.storeName, address: next.address, phone: next.phone, vatRegistration: next.vatRegistration });
    setFooter(next.receipt.footer);
    setRates(Object.fromEntries(next.taxRates.map((rate) => [rate.id, String(rate.rate)])));
  }

  useEffect(() => {
    api('/api/settings').then(({ settings: loaded }) => show(loaded)).catch((failure) => setError(failure.message));
  }, []);

  async function save(path, method, body, message = t('Settings saved.')) {
    try {
      const { settings: saved } = await api(path, { method, body: body ? JSON.stringify(body) : undefined });
      setSettings(saved);
      setRates(Object.fromEntries(saved.taxRates.map((rate) => [rate.id, String(rate.rate)])));
      toast(message);
      return true;
    } catch (failure) {
      toast(t(failure.message));
      return false;
    }
  }

  const saveReceipt = (change) => save('/api/settings', 'PATCH', { receipt: change });
  const storeField = (name) => ({ name, value: store[name], onChange: (event) => setStore((current) => ({ ...current, [name]: event.target.value })) });

  const head = (
    <div className="page-head">
      <div>
        <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
        <h1>{t('System settings')}</h1>
        <p>{t('Configure store details, receipts, appearance and preferences.')}</p>
      </div>
    </div>
  );

  if (!settings) {
    return <>{head}{error ? <p className="form-error" role="alert">{t(error)}</p> : <div className="card"><div className="empty">{t('Loading…')}</div></div>}</>;
  }

  return (
    <>
      {head}
      <div className="settings-grid">
        <form className="card" onSubmit={(event) => { event.preventDefault(); save('/api/settings', 'PATCH', store); }}>
          <h3>{t('Store details')}</h3>
          <label className="field settings-field">{t('Store name')}<input {...storeField('storeName')} maxLength={120} required /></label>
          <label className="field settings-field">{t('Address')}<textarea {...storeField('address')} rows="2" maxLength={300} /></label>
          <label className="field settings-field">{t('Phone')}<input {...storeField('phone')} maxLength={40} /></label>
          <label className="field settings-field">{t('VAT registration')}<input {...storeField('vatRegistration')} maxLength={60} /></label>
          <div className="setting-line"><span><strong>{t('Currency')}</strong><small>{t('Prices and records are kept in this currency.')}</small></span><b>{settings.currency}</b></div>
          <div className="setting-line"><span><strong>{t('Time zone')}</strong><small>{t('Daily figures and reports follow this.')}</small></span><b>{settings.timeZone}</b></div>
          <button type="submit" className="btn btn-primary settings-save">{t('Save settings')}</button>
        </form>

        <div className="card">
          <h3>{t('Receipt & billing')}</h3>
          <label className="field settings-field">{t('Receipt size')}
            <select name="receiptSize" value={settings.receipt.size} onChange={(event) => saveReceipt({ size: event.target.value })}>
              <option value="80mm">{t('80mm thermal')}</option>
              <option value="100mm">100mm</option>
              <option value="A4">A4</option>
            </select>
          </label>
          {RECEIPT_SWITCHES.map(([key, title, note]) => (
            <div className="setting-line" key={key}>
              <span><strong>{t(title)}</strong><small>{t(note)}</small></span>
              <Switch on={settings.receipt[key]} label={t(title)} onChange={(value) => saveReceipt({ [key]: value })} />
            </div>
          ))}
          <label className="field settings-field">{t('Receipt message')}
            <textarea name="receiptFooter" rows="2" maxLength={200} value={footer} placeholder={t('Leave empty to use the standard message.')} onChange={(event) => setFooter(event.target.value)} />
          </label>
          <button type="button" className="btn btn-primary settings-save" onClick={() => saveReceipt({ footer })}>{t('Save message')}</button>
        </div>

        <div className="card">
          <h3>{t('Tax configuration')}</h3>
          <p className="sub">{t('A new rate applies to sales from now on. Past bills keep the rate they were sold at.')}</p>
          {settings.taxRates.map((rate) => (
            <div className="setting-line" key={rate.id}>
              <span><strong>{rate.name}</strong><small>{t(rate.isDefault ? 'Default for new products' : 'Other rate')}</small></span>
              <span className="tax-edit">
                <input className="mini-input" type="number" min="0" max="100" step="0.01" aria-label={`${t('Rate')} ${rate.name}`} value={rates[rate.id] ?? ''} onChange={(event) => setRates((current) => ({ ...current, [rate.id]: event.target.value }))} />
                <span>%</span>
                <button type="button" className="btn btn-outline btn-sm" disabled={rates[rate.id] === String(rate.rate)} onClick={() => save(`/api/settings/tax-rates/${rate.id}`, 'PATCH', { rate: rates[rate.id] })}>{t('Save')}</button>
                {!rate.isDefault && <button type="button" className="btn btn-outline btn-sm" onClick={() => save(`/api/settings/tax-rates/${rate.id}/default`, 'POST')}>{t('Make default')}</button>}
              </span>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>{t('Payment configuration')}</h3>
          <p className="sub">{t('Only methods that are on appear at the till.')}</p>
          {settings.paymentMethods.map((method) => (
            <div className="setting-line" key={method.code}>
              <span>
                <strong>{t(method.code)}</strong>
                {!method.isCash && (
                  <small className="ref-toggle">
                    <input type="checkbox" id={`ref-${method.code}`} checked={method.requiresReference} onChange={(event) => save(`/api/settings/payment-methods/${encodeURIComponent(method.code)}`, 'PATCH', { requiresReference: event.target.checked })} />
                    <label htmlFor={`ref-${method.code}`}>{t('Ask for a reference')}</label>
                  </small>
                )}
              </span>
              <Switch on={method.active} label={t(method.code)} onChange={(value) => save(`/api/settings/payment-methods/${encodeURIComponent(method.code)}`, 'PATCH', { active: value })} />
            </div>
          ))}
        </div>

        <div className="card">
          <h3>{t('Appearance')}</h3>
          <p className="sub">{t('These apply to your own account.')}</p>
          <div className="setting-line"><span><strong>{t('Light theme')}</strong><small>{t('Pastel yellow and white')}</small></span><button type="button" className="btn btn-outline btn-sm" disabled={theme === 'light'} onClick={() => onTheme('light')}>{t('Use light')}</button></div>
          <div className="setting-line"><span><strong>{t('Dark theme (default)')}</strong><small>{t('Yellow and black')}</small></span><button type="button" className="btn btn-outline btn-sm" disabled={theme === 'dark'} onClick={() => onTheme('dark')}>{t('Use dark')}</button></div>
          <div className="setting-line">
            <span><strong>{t('Language')}</strong><small>{t('English, Tamil or Sinhala')}</small></span>
            <select name="settingsLanguage" aria-label={t('Language')} value={language} onChange={(event) => onLanguage(event.target.value)}>
              {LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
            </select>
          </div>
        </div>
      </div>
    </>
  );
}
