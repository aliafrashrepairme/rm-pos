import { useEffect, useState } from 'react';
import { can } from '../../app/access.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import CustomerForm from './CustomerForm.jsx';
import CustomerProfile from './CustomerProfile.jsx';
import { memberLabel } from './member.js';

export default function CustomersPage({ user }) {
  const { t } = useI18n();
  const toast = useToast();
  const canManage = can(user, 'customers.manage');
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(null);
  const [profileId, setProfileId] = useState(null);
  const [profileVersion, setProfileVersion] = useState(0);

  useEffect(() => { setPage(1); }, [search, status]);
  const params = new URLSearchParams({ page: String(page), status });
  if (search) params.set('q', search);
  const { data, error, reload } = useListRequest(`/api/customers?${params}`);
  const rows = data?.customers ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Customers & loyalty')}</h1>
          <p>{t('Customer profiles and loyalty points.')}</p>
        </div>
        {canManage && (
          <div className="toolbar head-actions">
            <button type="button" className="btn btn-primary" onClick={() => setForm({})}>＋ {t('Add customer')}</button>
          </div>
        )}
      </div>

      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input aria-label={t('Search name, code, phone or email…')} placeholder={t('Search name, code, phone or email…')} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
        <select className="filters" aria-label={t('Status')} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="active">{t('Active')}</option>
          <option value="inactive">{t('Inactive')}</option>
          <option value="all">{t('All')}</option>
        </select>
      </div>

      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr>{['Customer', 'Customer ID', 'Phone', 'Loyalty points', 'Member', 'Action'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!data && !error && <tr><td colSpan="6"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data && rows.length === 0 && <tr><td colSpan="6"><div className="empty">{t(search ? 'No records found.' : 'No customers yet. Add your first customer.')}</div></td></tr>}
            {rows.map((customer) => (
              <tr key={customer.id}>
                <td><b className="pname">{customer.name}</b>{!customer.active && <> <Status value="Inactive" label={t('Inactive')} /></>}</td>
                <td>{customer.code}</td>
                <td>{customer.phone || '—'}</td>
                <td><span className="badge">{customer.loyaltyPoints} {t('pts')}</span></td>
                <td>{t(memberLabel(customer))}</td>
                <td><button type="button" className="btn btn-outline btn-sm" onClick={() => setProfileId(customer.id)}>{t('View')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.pageSize && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}

      {profileId && (
        <CustomerProfile
          key={`${profileId}-${profileVersion}`}
          customerId={profileId}
          user={user}
          onClose={() => setProfileId(null)}
          onEdit={(customer) => { setProfileId(null); setForm(customer); }}
          onChanged={reload}
        />
      )}
      {form && (
        <CustomerForm
          customer={form.id ? form : null}
          user={user}
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
    </>
  );
}
