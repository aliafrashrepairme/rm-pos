import { useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { usePrintDocument } from '../../components/usePrintDocument.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { downloadCsv } from '../utils/reportExport.js';

// `loadRows` fetches every matching row, for reports the screen shows a page at a time.
export default function ReportExport({ user, report, title, subtitle, columns, rows, loadRows }) {
  const { t } = useI18n();
  const toast = useToast();
  const { printArea, startPrint } = usePrintDocument();
  const [busy, setBusy] = useState(false);

  if (!can(user, 'reports.export')) return null;

  async function run(kind) {
    setBusy(true);
    try {
      const all = loadRows ? await loadRows() : rows;
      await api('/api/reports/exported', { method: 'POST', body: JSON.stringify({ report, kind }) });
      if (kind === 'csv') {
        downloadCsv(`rm-report-${report}.csv`, columns, all);
      } else {
        startPrint({
          kind: 'print',
          size: 'a4',
          className: 'print-report',
          content: (
            <div className="report-print">
              <h1>{title}</h1>
              {subtitle && <p>{subtitle}</p>}
              <table>
                <thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
                <tbody>{all.map((row, index) => <tr key={row.id ?? index}>{columns.map((column) => <td key={column.key}>{column.value(row)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )
        });
      }
    } catch (failure) {
      toast(t(failure.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rpt-export">
      <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => run('print')}>⎙ {t('Print')}</button>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run('csv')}>{t('Export CSV')}</button>
      {printArea}
    </div>
  );
}
