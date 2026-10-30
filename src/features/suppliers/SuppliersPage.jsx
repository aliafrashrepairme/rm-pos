import { useEffect, useState } from 'react';
import { can } from '../../app/access.js';
import { money } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import NewOrderModal from '../purchases/NewOrderModal.jsx';
import SupplierForm from './SupplierForm.jsx';
import SupplierProfile from './SupplierProfile.jsx';

function Stars({ value }) {
  const { t } = useI18n();
  if (value === null) return <span className="muted small-note">{t('Not rated')}</span>;
  const whole = Math.round(value);
  return <><span className="stars" aria-hidden="true">{'★'.repeat(whole)}{'☆'.repeat(5 - whole)}</span> <b className="rating-number">{value.toFixed(1)}</b></>;
}

function initials(name) {
  return name.split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase();
}

export default function SuppliersPage({ user }) {
  const { t } = useI18n();
  const toast = useToast();
  const canManage = can(user, 'suppliers.manage');
  const canOrder = can(user, 'purchases.manage');
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(null);
  const [profileId, setProfileId] = useState(null);
  const [orderFor, setOrderFor] = useState(null);
  const [profileVersion, setProfileVersion] = useState(0);

  useEffect(() => { setPage(1); }, [search, status]);
  const params = new URLSearchParams({ page: String(page), status });
  if (search) params.set('q', search);
  const { data, error, reload } = useListRequest(`/api/suppliers?${params}`);
  const rows = data?.suppliers ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Suppliers')}</h1>
          <p>{t('Supplier profiles, performance, payment terms and outstanding balances.')}</p>
        </div>
        {canManage && (
          <div className="toolbar head-actions">
            <button type="button" className="btn btn-primary" onClick={() => setForm({})}>＋ {t('Add supplier')}</button>
          </div>
        )}
      </div>

      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input aria-label={t('Search name, contact, phone or city…')} placeholder={t('Search name, contact, phone or city…')} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
        <select className="filters" aria-label={t('Status')} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="active">{t('Active')}</option>
          <option value="inactive">{t('Inactive')}</option>
          <option value="all">{t('All')}</option>
        </select>
        {data && <span className="badge">{t('Balance payable')}: {money(data.balance)}</span>}
      </div>

      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {!data && !error && <div className="card"><div className="empty">{t('Loading…')}</div></div>}
      {data && rows.length === 0 && <div className="card"><div className="empty">{t(search ? 'No records found.' : 'No suppliers yet. Add your first supplier.')}</div></div>}

      <div className="sup-grid">
        {rows.map((supplier) => (
          <div className={`card sup-card ${supplier.active ? '' : 'inactive-card'}`} key={supplier.id}>
            <div className="sup-top">
              <div className="avatar">{initials(supplier.name)}</div>
              <div className="sup-title">
                <h3>{supplier.name}</h3>
                <div className="sub">{[supplier.code, supplier.city].filter(Boolean).join(' · ')}</div>
              </div>
              {!supplier.active && <Status value="Inactive" label={t('Inactive')} />}
            </div>
            <Stars value={supplier.rating} />
            <div className="setting-line"><span className="muted">{t('Contact')}</span><b>{[supplier.contactPerson, supplier.phone].filter(Boolean).join(' · ') || '—'}</b></div>
            <div className="setting-line"><span className="muted">{t('Payment terms')}</span><span className="chip gray">{t(supplier.paymentTerms)}</span></div>
            <div className="setting-line">
              <span className="muted">{t('On-time delivery')}</span>
              {supplier.stats.onTimePercent === null
                ? <span className="muted">—</span>
                : <span className="ontime"><span className="meter"><i style={{ width: `${supplier.stats.onTimePercent}%` }} /></span><b>{supplier.stats.onTimePercent}%</b></span>}
            </div>
            <div className="setting-line"><span className="muted">{t('Lead time')} · {t('Products')}</span><b>{supplier.leadTimeDays} {t('days')} · {supplier.stats.products}</b></div>
            <div className="setting-line"><span className="muted">{t('Balance payable')}</span><b className={supplier.stats.balance > 0 ? 'qty-down' : ''}>{money(supplier.stats.balance)}</b></div>
            <div className="sup-actions">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setProfileId(supplier.id)}>{t('View profile')}</button>
              {canOrder && supplier.active && <button type="button" className="btn btn-primary btn-sm" onClick={() => setOrderFor(supplier.id)}>＋ {t('New PO')}</button>}
            </div>
          </div>
        ))}
      </div>
      {data && data.total > data.pageSize && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}

      {profileId && (
        <SupplierProfile
          key={`${profileId}-${profileVersion}`}
          supplierId={profileId}
          user={user}
          onClose={() => setProfileId(null)}
          onEdit={(supplier) => { setProfileId(null); setForm(supplier); }}
          onChanged={reload}
        />
      )}
      {form && (
        <SupplierForm
          supplier={form.id ? form : null}
          onClose={() => setForm(null)}
          onSaved={(saved) => {
            const wasEdit = Boolean(form.id);
            setForm(null);
            toast(`${saved.code} ${saved.name}`);
            reload();
            if (wasEdit) {
              setProfileVersion((current) => current + 1);
              setProfileId(saved.id);
            }
          }}
        />
      )}
      {orderFor && (
        <NewOrderModal
          user={user}
          initialSupplierId={orderFor}
          onClose={() => setOrderFor(null)}
          onCreated={(purchase) => {
            setOrderFor(null);
            toast(`${purchase.poNo} · ${t(purchase.status)}`);
            reload();
          }}
        />
      )}
    </>
  );
}
