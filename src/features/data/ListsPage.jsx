import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

function Switch({ on, label, onChange }) {
  return <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

function AddRow({ placeholder, extra, onAdd, label }) {
  const [value, setValue] = useState('');
  return (
    <form className="list-add" onSubmit={async (event) => { event.preventDefault(); if (await onAdd(value)) setValue(''); }}>
      <input className="inp" aria-label={placeholder} placeholder={placeholder} value={value} maxLength={60} onChange={(event) => setValue(event.target.value)} required />
      {extra}
      <button type="submit" className="btn btn-outline btn-sm">＋ {label}</button>
    </form>
  );
}

export default function ListsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [lists, setLists] = useState(null);
  const [error, setError] = useState('');
  const [decimal, setDecimal] = useState(false);
  const [rate, setRate] = useState('');

  async function load() {
    try {
      setLists(await api('/api/lists'));
    } catch (failure) {
      setError(failure.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function send(path, method, body) {
    try {
      const reply = await api(path, { method, body: JSON.stringify(body) });
      if (reply.categories) setLists(reply);
      else await load();
      toast(t('Saved.'));
      return true;
    } catch (failure) {
      toast(t(failure.message));
      return false;
    }
  }

  async function rename(category, value) {
    const name = value.trim();
    if (name && name !== category.name) await send(`/api/categories/${category.id}`, 'PATCH', { name });
  }

  const head = (
    <div className="page-head">
      <div>
        <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
        <h1>{t('List management')}</h1>
        <p>{t('Configure reusable lists used across the store.')}</p>
      </div>
    </div>
  );
  if (!lists) return <>{head}{error ? <p className="form-error" role="alert">{t(error)}</p> : <div className="card"><div className="empty">{t('Loading…')}</div></div>}</>;

  return (
    <>
      {head}
      <div className="settings-grid">
        <div className="card">
          <h3>{t('Product categories')}</h3>
          <AddRow placeholder={t('New category name')} label={t('Add')} onAdd={(name) => send('/api/categories', 'POST', { name })} />
          {lists.categories.map((category) => (
            <div className="setting-line" key={category.id}>
              <span>
                <input
                  className="inp list-name"
                  aria-label={`${t('Category')} ${category.name}`}
                  defaultValue={category.name}
                  key={category.name}
                  maxLength={100}
                  onBlur={(event) => rename(category, event.target.value)}
                />
                <small>{category.products} {t('products')}</small>
              </span>
              <Switch on={category.active} label={`${t('Active')} ${category.name}`} onChange={(active) => send(`/api/categories/${category.id}`, 'PATCH', { active })} />
            </div>
          ))}
        </div>

        <div className="card">
          <h3>{t('Units')}</h3>
          <AddRow
            placeholder={t('New unit name')}
            label={t('Add')}
            extra={<label className="list-check"><input type="checkbox" checked={decimal} onChange={(event) => setDecimal(event.target.checked)} /> {t('Allows part quantities')}</label>}
            onAdd={async (code) => {
              const done = await send('/api/lists/units', 'POST', { code, allowDecimal: decimal });
              if (done) setDecimal(false);
              return done;
            }}
          />
          {lists.units.map((unit) => (
            <div className="setting-line" key={unit.code}>
              <span>
                <strong>{t(unit.code)}</strong>
                <small className="ref-toggle">
                  <input type="checkbox" id={`unit-${unit.code}`} checked={unit.allowDecimal} onChange={(event) => send(`/api/lists/units/${encodeURIComponent(unit.code)}`, 'PATCH', { allowDecimal: event.target.checked })} />
                  <label htmlFor={`unit-${unit.code}`}>{t('Allows part quantities')}</label>
                  · {unit.products} {t('products')}
                </small>
              </span>
              <Switch on={unit.active} label={`${t('Active')} ${unit.code}`} onChange={(active) => send(`/api/lists/units/${encodeURIComponent(unit.code)}`, 'PATCH', { active })} />
            </div>
          ))}
        </div>

        <div className="card">
          <h3>{t('Tax rates')}</h3>
          <p className="sub">{t('Change a rate or the default in Settings.')}</p>
          <AddRow
            placeholder={t('New tax rate name')}
            label={t('Add')}
            extra={<input className="mini-input" type="number" min="0" max="100" step="0.01" aria-label={t('Rate')} placeholder="%" value={rate} onChange={(event) => setRate(event.target.value)} required />}
            onAdd={async (name) => {
              const done = await send('/api/lists/tax-rates', 'POST', { name, rate });
              if (done) setRate('');
              return done;
            }}
          />
          {lists.taxRates.map((item) => (
            <div className="setting-line" key={item.id}>
              <span><strong>{item.name} · {item.rate}%</strong><small>{item.isDefault ? `${t('Default for new products')} · ` : ''}{item.products} {t('products')}</small></span>
              <Switch on={item.active} label={`${t('Active')} ${item.name}`} onChange={(active) => send(`/api/lists/tax-rates/${item.id}`, 'PATCH', { active })} />
            </div>
          ))}
        </div>

        <div className="card">
          <h3>{t('Fixed lists')}</h3>
          <p className="sub">{t('These are built in, because records and reports depend on them.')}</p>
          <div className="setting-line"><span><strong>{t('Adjustment reasons')}</strong><small>Damaged, Expired, Theft / Loss, Found stock, Supplier return, Data correction</small></span></div>
          <div className="setting-line"><span><strong>{t('Document prefixes')}</strong><small>{lists.prefixes.join(', ')}</small></span></div>
        </div>
      </div>
    </>
  );
}
