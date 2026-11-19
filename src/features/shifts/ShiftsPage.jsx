import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { dateTime, money } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import Modal from '../../components/Modal.jsx';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { usePrintDocument } from '../../components/usePrintDocument.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

function OpenShift({ options, onClose, onDone }) {
  const { t } = useI18n();
  const [counterId, setCounterId] = useState(options.defaultCounterId ?? options.counters[0]?.id ?? '');
  const [openingCash, setOpeningCash] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/shifts', { method: 'POST', body: JSON.stringify({ counterId, openingCash, password }) });
      onDone();
    } catch (failure) {
      setError(failure.message);
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <Modal className="shift-modal" title={t('Open cash shift')} description={t('Choose your counter, enter the opening float and confirm with your password.')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">{t('Counter')}
          <div className="counter-choices" role="radiogroup" aria-label={t('Counter')}>
            {options.counters.map((counter) => (
              <button
                key={counter.id}
                type="button"
                role="radio"
                aria-checked={counterId === counter.id}
                className={`counter-choice ${counterId === counter.id ? 'active' : ''}`}
                disabled={counter.inUse}
                onClick={() => setCounterId(counter.id)}
              >
                <b>{counter.name}</b>
                <small>{counter.inUse ? t('In use') : counter.id === options.defaultCounterId ? t('Your counter') : t('Available')}</small>
              </button>
            ))}
          </div>
        </div>
        <label className="field">{t('Opening cash (LKR)')}<input name="openingCash" type="number" min="0" step="0.01" value={openingCash} onChange={(event) => setOpeningCash(event.target.value)} required autoFocus /></label>
        <label className="field">{t('Your password')}<input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline btn-lg" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !counterId}>{t('Open shift')}</button>
        </div>
      </form>
    </Modal>
  );
}

function ShiftReport({ shift }) {
  const { t } = useI18n();
  const figures = shift.figures;
  return (
    <div className="shift-report">
      <div className="total-row"><span>{t('Cashier')}</span><b>{shift.cashier}</b></div>
      <div className="total-row"><span>{t('Counter')}</span><b>{shift.counter}</b></div>
      <div className="total-row"><span>{t('Opened')}</span><b>{dateTime(shift.openedAt)}</b></div>
      {shift.closedAt && <div className="total-row"><span>{t('Closed')}</span><b>{dateTime(shift.closedAt)}</b></div>}
      <hr />
      <div className="total-row"><span>{t('Bills')}</span><b>{figures.bills}</b></div>
      <div className="total-row"><span>{t('Total sales')}</span><b>{money(figures.sales)}</b></div>
      {Object.entries(figures.byMethod).map(([method, amount]) => <div className="total-row muted" key={method}><span>{t(method)}</span><span>{money(amount)}</span></div>)}
      <div className="total-row"><span>{t('Refunds')}</span><b>{money(figures.refunds)}</b></div>
      <div className="total-row"><span>{t('Expenses')}</span><b>{money(figures.expenses)}</b></div>
      <hr />
      <div className="total-row"><span>{t('Opening cash')}</span><span>{money(shift.openingCash)}</span></div>
      <div className="total-row"><span>+ {t('Cash sales')}</span><span>{money(figures.cashSales)}</span></div>
      {figures.cashCollected > 0 && <div className="total-row"><span>+ {t('Credit repayments in cash')}</span><span>{money(figures.cashCollected)}</span></div>}
      <div className="total-row"><span>− {t('Cash refunds')}</span><span>{money(figures.cashRefunds)}</span></div>
      <div className="total-row"><span>− {t('Cash expenses')}</span><span>{money(figures.cashExpenses)}</span></div>
      <div className="total-row grand"><span>{t('Expected cash')}</span><span>{money(shift.expectedCash)}</span></div>
      {shift.countedCash !== null && (
        <>
          <div className="total-row"><span>{t('Cash counted')}</span><b>{money(shift.countedCash)}</b></div>
          <div className={`total-row ${shift.variance !== 0 ? 'qty-down' : ''}`}><span>{t('Variance')}</span><b>{money(shift.variance)}</b></div>
        </>
      )}
    </div>
  );
}

function ShiftModal({ shiftId, onClose, onChanged }) {
  const { t } = useI18n();
  const toast = useToast();
  const [shift, setShift] = useState(null);
  const [counted, setCounted] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { printArea, startPrint } = usePrintDocument();

  async function load() {
    try {
      setShift((await api(`/api/shifts/${shiftId}`)).shift);
    } catch (failure) {
      setError(failure.message);
    }
  }

  useEffect(() => { load(); }, [shiftId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function close(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { variance } = await api(`/api/shifts/${shiftId}/close`, { method: 'POST', body: JSON.stringify({ countedCash: counted, password }) });
      toast(`${t('Shift closed. Cash variance:')} ${money(variance)}`);
      onChanged();
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  const liveVariance = counted === '' || !shift ? null : Number(counted) - shift.expectedCash;

  // A saved PDF doubles as a preview, because the Windows print dialog shows none for this app.
  function printReport(kind) {
    startPrint({
      kind,
      fileName: `${shift.shiftNo}.pdf`,
      className: 'print-report',
      size: 'a5',
      content: <div className="report-print"><h1>{t('Shift report')} · {shift.shiftNo}</h1><ShiftReport shift={shift} /></div>
    });
  }

  return (
    <Modal className="shift-modal" title={shift ? `${t('Shift report')} · ${shift.shiftNo}` : t('Shift report')} onClose={onClose}>
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      {!shift && !error && <div className="empty">{t('Loading…')}</div>}
      {shift && (
        <>
          <div className="modal-scroll"><ShiftReport shift={shift} /></div>
          {shift.status === 'Open' ? (
            <form onSubmit={close}>
              <label className="field settings-field">{t('Cash counted (LKR)')}<input name="countedCash" type="number" min="0" step="0.01" value={counted} onChange={(event) => setCounted(event.target.value)} required /></label>
              <label className="field settings-field">{t('Your password')}<input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
              {liveVariance !== null && <div className={`total-row ${liveVariance !== 0 ? 'qty-down' : ''}`}><span>{t('Variance')}</span><b>{money(liveVariance)}</b></div>}
              <div className="modal-actions-row">
                <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
                <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>{t('Close & reconcile')}</button>
              </div>
            </form>
          ) : (
            <div className="modal-actions-row">
              <button type="button" className="btn btn-outline" onClick={() => printReport('print')}>⎙ {t('Print')}</button>
              <button type="button" className="btn btn-outline" onClick={() => printReport('pdf')}>⇩ {t('Download PDF')}</button>
              <button type="button" className="btn btn-primary" onClick={onClose}>{t('Close')}</button>
            </div>
          )}
        </>
      )}
      {printArea}
    </Modal>
  );
}

function ExpenseForm({ options, canManage, onClose, onDone }) {
  const { t } = useI18n();
  const [values, setValues] = useState({ category: options.categories[0], amount: '', description: '', paidFromCash: Boolean(options.current) || Boolean(options.openShifts[0]), shiftId: options.openShifts[0]?.id ?? '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (name) => ({ name, value: values[name], onChange: (event) => setValues((current) => ({ ...current, [name]: event.target.value })) });

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/shifts/expenses', { method: 'POST', body: JSON.stringify(values) });
      onDone();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('Record expense')} description={t('Link the expense to the active shift.')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field">{t('Category')}<select {...field('category')}>{options.categories.map((name) => <option key={name} value={name}>{t(name)}</option>)}</select></label>
          <label className="field">{t('Amount (LKR)')}<input {...field('amount')} type="number" min="0.01" step="0.01" required autoFocus /></label>
          <label className="field full">{t('Description')}<input {...field('description')} maxLength={300} required /></label>
          {canManage && options.openShifts.length > 0 && (
            <label className="field">{t('Shift')}
              <select {...field('shiftId')}>
                <option value="">{t('No shift')}</option>
                {options.openShifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.shift_no}</option>)}
              </select>
            </label>
          )}
          <label className="list-check field full"><input name="paidFromCash" type="checkbox" checked={values.paidFromCash} onChange={(event) => setValues((current) => ({ ...current, paidFromCash: event.target.checked }))} /> {t('Paid from the cash drawer')}</label>
        </div>
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('Save record')}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function ShiftsPage({ user }) {
  const { t } = useI18n();
  const toast = useToast();
  const canManage = can(user, 'shifts.manage');
  const [tab, setTab] = useState('shifts');
  const [page, setPage] = useState(1);
  const [expensePage, setExpensePage] = useState(1);
  const [dialog, setDialog] = useState(null);
  const shifts = useListRequest(`/api/shifts?page=${page}`);
  const expenses = useListRequest(`/api/shifts/expenses?page=${expensePage}`);
  const options = useListRequest('/api/shifts/options');

  const reload = () => { shifts.reload(); expenses.reload(); options.reload(); };
  const canOpen = options.data?.canOpen && !options.data.current;
  const error = shifts.error || expenses.error || options.error;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Shifts & cash register')}</h1>
          <p>{t('Open or close a shift and reconcile expected cash against counted cash.')}</p>
        </div>
        {options.data && (
          <div className="toolbar head-actions">
            <button type="button" className="btn btn-outline" onClick={() => setDialog({ kind: 'expense' })}>＋ {t('Record expense')}</button>
          </div>
        )}
      </div>
      {canOpen && (
        <button type="button" className="btn btn-primary open-shift-hero" onClick={() => setDialog({ kind: 'open' })}>
          <span aria-hidden="true">◴</span>
          <span><b>{t('Open shift')}</b><small>{t('Start your cash drawer for today')}</small></span>
        </button>
      )}
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="tabs">
        {[['shifts', 'Shifts'], ['expenses', 'Expenses']].map(([key, label]) => <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{t(label)}</button>)}
      </div>

      {tab === 'shifts' && (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr>{['Shift ID', 'Cashier', 'Counter', 'Opened', 'Opening cash', 'Expected cash', 'Variance', 'Status', 'Action'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
              <tbody>
                {!shifts.data && !error && <tr><td colSpan="9"><div className="empty">{t('Loading…')}</div></td></tr>}
                {shifts.data?.shifts.length === 0 && <tr><td colSpan="9"><div className="empty">{t('No records found.')}</div></td></tr>}
                {shifts.data?.shifts.map((shift) => (
                  <tr key={shift.id}>
                    <td><b>{shift.shiftNo}</b></td>
                    <td>{shift.cashier}</td>
                    <td>{shift.counter}</td>
                    <td>{dateTime(shift.openedAt)}</td>
                    <td>{money(shift.openingCash)}</td>
                    <td>{money(shift.expectedCash)}</td>
                    <td className={shift.variance ? 'qty-down' : ''}>{shift.variance === null ? '—' : money(shift.variance)}</td>
                    <td><Status value={shift.status} label={t(shift.status)} /></td>
                    <td><button type="button" className={`btn btn-sm ${shift.status === 'Open' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setDialog({ kind: 'shift', id: shift.id })}>{t(shift.status === 'Open' ? 'Close & reconcile' : 'View report')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shifts.data && shifts.data.total > shifts.data.pageSize && <Pager page={shifts.data.page} pageSize={shifts.data.pageSize} total={shifts.data.total} onPage={setPage} />}
        </>
      )}

      {tab === 'expenses' && (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr>{['Date', 'Category', 'Description', 'Shift', 'Paid from', 'Recorded by', 'Amount'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
              <tbody>
                {expenses.data?.expenses.length === 0 && <tr><td colSpan="7"><div className="empty">{t('No records found.')}</div></td></tr>}
                {expenses.data?.expenses.map((row) => (
                  <tr key={row.expenseNo}>
                    <td>{dateTime(row.createdAt)}</td>
                    <td>{t(row.category)}</td>
                    <td>{row.description}</td>
                    <td>{row.shiftNo || '—'}</td>
                    <td>{t(row.paidFromCash ? 'Cash drawer' : 'Elsewhere')}</td>
                    <td>{row.createdBy}</td>
                    <td>{money(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {expenses.data && expenses.data.total > expenses.data.pageSize && <Pager page={expenses.data.page} pageSize={expenses.data.pageSize} total={expenses.data.total} onPage={setExpensePage} />}
        </>
      )}

      {dialog?.kind === 'open' && <OpenShift options={options.data} onClose={() => setDialog(null)} onDone={() => { setDialog(null); toast(t('Shift opened.')); reload(); }} />}
      {dialog?.kind === 'shift' && <ShiftModal shiftId={dialog.id} onClose={() => setDialog(null)} onChanged={reload} />}
      {dialog?.kind === 'expense' && <ExpenseForm options={options.data} canManage={canManage} onClose={() => setDialog(null)} onDone={() => { setDialog(null); toast(t('Expense recorded.')); reload(); }} />}
    </>
  );
}
