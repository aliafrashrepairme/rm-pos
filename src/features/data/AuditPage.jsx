import { useEffect, useState } from 'react';
import { apiFile } from '../../api.js';
import { dateTime } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import ReportFilters from '../../reports/components/ReportFilters.jsx';
import '../../reports/styles/reports.css';
import { queryString, usePeriod } from '../../reports/utils/useReportData.js';
import { saveFile } from './saveFile.js';

export default function AuditPage() {
  const { t } = useI18n();
  const toast = useToast();
  const period = usePeriod('last30');
  const [action, setAction] = useState('');
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [page, setPage] = useState(1);
  const filter = queryString({ ...period.params, action, q: search });
  useEffect(() => { setPage(1); }, [filter]);
  const { data, error } = useListRequest(`/api/audit?${filter}&page=${page}`);
  const actions = useListRequest('/api/audit/actions').data?.actions ?? [];
  const entries = data?.entries ?? [];

  async function exportLog() {
    try {
      saveFile(await apiFile(`/api/audit/export?${filter}`), 'rm-audit-log.csv');
    } catch (failure) {
      toast(t(failure.message));
    }
  }

  return (
    <div className="rpt-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Audit log')}</h1>
          <p>{t('Review system actions for accountability and traceability.')}</p>
        </div>
        <div className="toolbar head-actions"><button type="button" className="btn btn-primary" onClick={exportLog}>{t('Export CSV')}</button></div>
      </div>
      <ReportFilters
        period={period}
        type={action}
        types={actions}
        onType={setAction}
        typeLabel="Action"
        allTypesLabel="All actions"
        search={typed}
        onSearch={setTyped}
        onReset={() => { period.reset(); setAction(''); setTyped(''); }}
      />
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr>{['Time', 'User', 'Action', 'Reference / Details', 'Record'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!data && !error && <tr><td colSpan="5"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data && entries.length === 0 && <tr><td colSpan="5"><div className="empty">{t('No records found.')}</div></td></tr>}
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{dateTime(entry.createdAt)}</td>
                <td><b>{entry.user}</b></td>
                <td>{t(entry.action)}</td>
                <td>{entry.description || '—'}</td>
                <td className="small-note muted">{entry.entityId ? `${entry.entityType} · ${entry.entityId}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.pageSize && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </div>
  );
}
