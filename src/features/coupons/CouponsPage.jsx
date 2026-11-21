import { useState } from 'react';
import { api } from '../../api.js';
import { useListRequest } from '../../app/useListRequest.js';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const EMPTY = { code: '', percent: '', description: '', firstPurchaseOnly: false, validFrom: '', validUntil: '' };
const percentOf = (rate) => String(Math.round(rate * 10000) / 100);

// The Manager's coupon codes. Only the best single discount applies at the till (coupon, member or regular).
export default function CouponsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { data, error } = useListRequest('/api/coupons');
  const [coupons, setCoupons] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const list = coupons ?? data?.coupons;

  async function send(path, method, body, message) {
    setProblem('');
    setBusy(true);
    try {
      const result = await api(path, { method, body: JSON.stringify(body) });
      setCoupons(result.coupons);
      toast(t(message));
      return true;
    } catch (failure) {
      setProblem(failure.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const fields = () => ({
    rate: Number(form.percent) / 100,
    description: form.description,
    firstPurchaseOnly: form.firstPurchaseOnly,
    validFrom: form.validFrom || null,
    validUntil: form.validUntil || null
  });

  async function submit(event) {
    event.preventDefault();
    const ok = editing
      ? await send(`/api/coupons/${editing}`, 'PATCH', fields(), 'Coupon saved.')
      : await send('/api/coupons', 'POST', { code: form.code, ...fields() }, 'Coupon added.');
    if (ok) {
      setForm(EMPTY);
      setEditing(null);
    }
  }

  function edit(coupon) {
    setEditing(coupon.code);
    setForm({ code: coupon.code, percent: percentOf(coupon.rate), description: coupon.description, firstPurchaseOnly: coupon.firstPurchaseOnly, validFrom: coupon.validFrom ?? '', validUntil: coupon.validUntil ?? '' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const set = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Coupons')}</h1>
          <p>{t('Codes the cashier types on POS for a discount. Only the best single discount applies: coupon, member offer or regular-customer offer.')}</p>
        </div>
      </div>
      {(error || problem) && <p className="form-error" role="alert">{t(error || problem)}</p>}

      <form className="card dash-gap" onSubmit={submit}>
        <h3>{t(editing ? 'Change coupon' : 'New coupon')}{editing ? ` · ${editing}` : ''}</h3>
        <div className="form-grid">
          <label className="field">{t('Code')}
            <input name="code" value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) }))} placeholder={t('e.g. DIWALI15')} required minLength={3} disabled={Boolean(editing)} />
          </label>
          <label className="field">{t('Discount (%)')}
            <input name="percent" type="number" min="1" max="50" step="0.01" value={form.percent} onChange={set('percent')} required />
          </label>
          <label className="field full">{t('Description')}
            <input name="description" value={form.description} onChange={set('description')} maxLength={120} placeholder={t('e.g. Festival offer for everyone')} />
          </label>
          <label className="field">{t('Valid from (optional)')}
            <input name="validFrom" type="date" value={form.validFrom} onChange={set('validFrom')} />
          </label>
          <label className="field">{t('Valid until (optional)')}
            <input name="validUntil" type="date" value={form.validUntil} min={form.validFrom || undefined} onChange={set('validUntil')} />
          </label>
          <label className="field full checkbox-field">
            <span><input name="firstPurchaseOnly" type="checkbox" checked={form.firstPurchaseOnly} onChange={set('firstPurchaseOnly')} /> {t('First-time buyers only')}</span>
          </label>
        </div>
        <div className="modal-actions-row">
          {editing && <button type="button" className="btn btn-outline" onClick={() => { setEditing(null); setForm(EMPTY); }}>{t('Cancel')}</button>}
          <button type="submit" className="btn btn-primary" disabled={busy}>{editing ? t('Save coupon') : `＋ ${t('Add coupon')}`}</button>
        </div>
      </form>

      <div className="table-wrap dash-gap">
        <table>
          <thead><tr>{['Code', 'Discount', 'Description', 'Who', 'Dates', 'Status', 'Actions'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!list && !error && <tr><td colSpan="7"><div className="empty">{t('Loading…')}</div></td></tr>}
            {list?.length === 0 && <tr><td colSpan="7"><div className="empty">{t('No coupons yet. Add the first one above.')}</div></td></tr>}
            {list?.map((coupon) => (
              <tr key={coupon.code}>
                <td><b className="mono">{coupon.code}</b></td>
                <td>{percentOf(coupon.rate)}%</td>
                <td>{coupon.description || '—'}</td>
                <td>{t(coupon.firstPurchaseOnly ? 'First-time buyers' : 'Everyone')}</td>
                <td>{coupon.validFrom || coupon.validUntil ? `${coupon.validFrom ?? '…'} → ${coupon.validUntil ?? '…'}` : t('Always')}</td>
                <td>
                  <Status value={coupon.usableToday ? 'Active' : 'Inactive'} label={t(!coupon.active ? 'Switched off' : coupon.usableToday ? 'Usable today' : 'Outside its dates')} />
                </td>
                <td className="row-actions">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => edit(coupon)}>{t('Edit')}</button>
                  {coupon.active
                    ? <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => send(`/api/coupons/${coupon.code}`, 'PATCH', { active: false }, 'Coupon switched off.')}>{t('Switch off')}</button>
                    : <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => send(`/api/coupons/${coupon.code}`, 'PATCH', { active: true }, 'Coupon switched on.')}>{t('Switch on')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small-note">{t('Coupons cannot be deleted, because past bills refer to them. Switch a coupon off to stop it.')}</p>
    </>
  );
}
