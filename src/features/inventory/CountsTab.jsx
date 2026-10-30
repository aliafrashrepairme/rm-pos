import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { dateTime, money, quantity } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import Modal from '../../components/Modal.jsx';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

function NewCountForm({ onClose, onStarted }) {
  const { t } = useI18n();
  const [name, setName] = useState(`${t('Cycle count')} ${new Date().toLocaleDateString('en-GB')}`);
  const [scope, setScope] = useState('all');
  const [blind, setBlind] = useState('yes');
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/products/options').then((options) => setCategories(options.categories.filter((item) => item.active))).catch((failure) => setError(failure.message));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { count } = await api('/api/inventory/counts', { method: 'POST', body: JSON.stringify({ name, scope, blind: blind === 'yes' }) });
      onStarted(count);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('New stock count')} description={t('Snapshot system quantities and start counting.')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field full">{t('Count name')}<input name="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus /></label>
          <label className="field">{t('Scope')}
            <select name="scope" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="all">{t('Full store')}</option>
              <option value="low">{t('Below reorder level')}</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
          <label className="field">{t('Blind count')}
            <select name="blind" value={blind} onChange={(event) => setBlind(event.target.value)}>
              <option value="yes">{t('Yes — hide system qty')}</option>
              <option value="no">{t('No — show system qty')}</option>
            </select>
          </label>
        </div>
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('Start count')}</button>
        </div>
      </form>
    </Modal>
  );
}

function CountDetail({ id, user, onBack }) {
  const { t } = useI18n();
  const toast = useToast();
  const [count, setCount] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pendingSaves = useRef(new Set());

  const load = useCallback(async () => {
    try {
      setCount((await api(`/api/inventory/counts/${id}`)).count);
    } catch (failure) {
      setError(failure.message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  function setLocal(productId, value) {
    setCount((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.productId === productId ? { ...line, draft: value } : line))
    }));
  }

  async function saveLine(line) {
    if (line.draft === undefined) return;
    const counted = line.draft === '' ? null : Number(line.draft);
    if (counted === line.counted) return;
    const saving = api(`/api/inventory/counts/${id}/lines/${line.productId}`, { method: 'PUT', body: JSON.stringify({ counted }) })
      .then(() => {
        setCount((current) => ({
          ...current,
          lines: current.lines.map((item) => (item.productId === line.productId ? { ...item, counted } : item))
        }));
      })
      .catch((failure) => {
        toast(t(failure.message));
        return load();
      });
    pendingSaves.current.add(saving);
    await saving;
    pendingSaves.current.delete(saving);
  }

  async function act(path, message) {
    setBusy(true);
    setConfirming(false);
    try {
      // Whatever was just typed must reach the server before the count moves on.
      await Promise.all(pendingSaves.current);
      const result = await api(`/api/inventory/counts/${id}/${path}`, { method: 'POST' });
      setCount(result.count);
      toast(message(result));
    } catch (failure) {
      toast(t(failure.message));
      load();
    } finally {
      setBusy(false);
    }
  }

  async function scanCode(code) {
    try {
      const scan = await api(`/api/inventory/counts/${id}/scan`, { method: 'POST', body: JSON.stringify({ code }) });
      const known = count.lines.some((line) => line.productId === scan.productId);
      if (known) {
        setCount((current) => ({
          ...current,
          lines: current.lines.map((line) => (line.productId === scan.productId ? { ...line, counted: scan.counted, draft: undefined } : line))
        }));
      } else {
        await load();
      }
      toast(`${scan.name}: ${t('Counted')} ${quantity(scan.counted)}`);
    } catch (failure) {
      toast(t(failure.message));
    }
  }

  if (error) return <p className="form-error" role="alert">{t(error)}</p>;
  if (!count) return <div className="card"><div className="empty">{t('Loading…')}</div></div>;

  const editing = count.status === 'In Progress';
  const done = count.lines.filter((line) => line.counted !== null).length;
  const approver = can(user, 'counts.approve');
  const variance = count.showExpected ? count.lines.reduce((sum, line) => sum + (line.varianceValue || 0), 0) : null;

  return (
    <>
      <div className="tab-actions">
        <button type="button" className="btn btn-outline" onClick={onBack}>← {t('All counts')}</button>
        {editing && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setConfirming(true)}>{t('Submit for approval')}</button>}
        {count.status === 'Submitted' && approver && (
          <>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => act('reopen', () => count.countNo)}>{t('Re-open')}</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('approve', (result) => `${count.countNo} · ${result.posted} ${t('variance(s) posted')}`)}>✓ {t('Approve & update stock')}</button>
          </>
        )}
        {count.status === 'Submitted' && !approver && <span className="chip">{t('Waiting for manager approval')}</span>}
      </div>
      <div className="count-summary">
        <span>
          <b>{count.countNo} · {count.name}</b><br />
          <span className="sub">{count.scope} · {dateTime(count.createdAt)} · {count.user}{count.blind ? ` · ${t('Blind count')}` : ''}</span>
        </span>
        <span>{t('Counted')} <b>{done}/{count.lines.length}</b></span>
        <Status value={count.status} label={t(count.status)} />
      </div>
      {editing && (
        <form
          className="search count-scan"
          onSubmit={(event) => {
            event.preventDefault();
            const code = event.currentTarget.elements.code.value;
            event.currentTarget.reset();
            if (code.trim()) scanCode(code.trim());
          }}
        >
          <span>⌸</span>
          <input name="code" aria-label={t('Scan or type a barcode — adds +1 automatically')} placeholder={t('Scan or type a barcode — adds +1 automatically')} autoComplete="off" />
        </form>
      )}
      {count.showExpected && !editing && <p className="notice">{t('Variance value')}: <b>{money(variance)}</b></p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {['Product', 'Location'].map((heading) => <th key={heading}>{t(heading)}</th>)}
              {count.showExpected && <th>{t('System qty')}</th>}
              <th>{t('Counted')}</th>
              {count.showExpected && !editing && <th>{t('Variance')}</th>}
            </tr>
          </thead>
          <tbody>
            {count.lines.map((line) => (
              <tr key={line.productId}>
                <td><b className="pname">{line.name}</b><br /><span className="muted small-note">{line.sku}</span></td>
                <td>{line.location}</td>
                {count.showExpected && <td>{quantity(line.expected)}</td>}
                <td>
                  {editing ? (
                    <input
                      className="mini-input"
                      type="number"
                      min="0"
                      step="any"
                      aria-label={`${t('Counted')} ${line.name}`}
                      value={line.draft ?? line.counted ?? ''}
                      placeholder="—"
                      onChange={(event) => setLocal(line.productId, event.target.value)}
                      onBlur={() => saveLine(line)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          saveLine(line);
                        }
                      }}
                    />
                  ) : <b>{line.counted === null ? '—' : quantity(line.counted)}</b>}
                </td>
                {count.showExpected && !editing && <td><b className={line.variance < 0 ? 'qty-down' : line.variance > 0 ? 'qty-up' : ''}>{line.variance > 0 ? '+' : ''}{quantity(line.variance)}</b></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirming && (
        <Modal
          title={t('Submit for approval')}
          description={done < count.lines.length ? `${count.lines.length - done} ${t('item(s) not counted yet. Uncounted items keep their system qty.')}` : t('All items counted.')}
          onClose={() => setConfirming(false)}
        >
          <div className="modal-actions-row">
            <button type="button" className="btn btn-outline" onClick={() => setConfirming(false)}>{t('Cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={() => act('submit', () => `${count.countNo} · ${t('Submitted')}`)}>{t('Submit for approval')}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

export default function CountsTab({ user }) {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  const [starting, setStarting] = useState(false);
  const { data, error, reload } = useListRequest(`/api/inventory/counts?page=${page}`);

  if (openId) return <CountDetail id={openId} user={user} onBack={() => { setOpenId(null); reload(); }} />;

  return (
    <>
      <div className="tab-actions">
        <button type="button" className="btn btn-primary" onClick={() => setStarting(true)}>＋ {t('New stock count')}</button>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>{['Count', 'Name', 'Created', 'Counted by', 'Progress', 'Status', 'Action'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr>
          </thead>
          <tbody>
            {!data && !error && <tr><td colSpan="7"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.counts.length === 0 && <tr><td colSpan="7"><div className="empty">{t('No records found.')}</div></td></tr>}
            {data?.counts.map((row) => (
              <tr key={row.id}>
                <td><b>{row.countNo}</b></td>
                <td>{row.name}{row.blind && <> <span className="chip gray">{t('Blind')}</span></>}</td>
                <td>{dateTime(row.createdAt)}</td>
                <td>{row.user}</td>
                <td>{row.counted}/{row.lines}</td>
                <td><Status value={row.status} label={t(row.status)} /></td>
                <td><button type="button" className={`btn btn-sm ${row.status === 'In Progress' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setOpenId(row.id)}>{t(row.status === 'In Progress' ? 'Continue' : 'Open')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      {starting && <NewCountForm onClose={() => setStarting(false)} onStarted={(count) => { setStarting(false); setOpenId(count.id); }} />}
    </>
  );
}
