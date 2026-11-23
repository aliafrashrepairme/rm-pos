import { useEffect, useState } from 'react';
import { money } from '../app/format.js';
import Modal from '../components/Modal.jsx';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { isOnline, probe, subscribeConnection } from './connection.js';
import { removeDraft, retryDraft, sendDrafts, subscribeDrafts } from './outbox.js';

export function useConnection() {
  const [online, setOnline] = useState(isOnline);
  useEffect(() => subscribeConnection(setOnline), []);
  return online;
}

export function useDrafts() {
  const [entries, setEntries] = useState([]);
  useEffect(() => subscribeDrafts(setEntries), []);
  return entries;
}

const STATUS_LABEL = { pending: 'Waiting to send', sending: 'Sending…', sent: 'Sent', failed: 'Failed' };
const STATUS_TONE = { pending: 'warn', sending: 'warn', sent: '', failed: 'red' };

function when(iso) {
  return new Date(iso).toLocaleString('en-LK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// The sync badge in the top bar, and the list of drafts it opens.
export default function SyncStatus({ user, serverSession, onSignInAgain, onOpenInPos }) {
  const { t } = useI18n();
  const online = useConnection();
  const entries = useDrafts();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const mine = entries.filter((entry) => entry.userId === user.id);
  const others = entries.filter((entry) => entry.userId !== user.id && entry.status !== 'sent');
  const waiting = mine.filter((entry) => entry.status === 'pending' || entry.status === 'sending').length;
  const sending = mine.some((entry) => entry.status === 'sending');
  const failed = mine.filter((entry) => entry.status === 'failed').length;

  let tone = '';
  let label = t('Online');
  if (!online) { tone = 'red'; label = waiting ? `${t('Offline')} · ${waiting} ${t('waiting')}` : t('Offline'); }
  else if (sending) { tone = 'warn'; label = `${t('Sending')} ${waiting}…`; }
  else if (waiting) { tone = 'warn'; label = `${waiting} ${t('waiting to send')}`; }
  if (failed) { tone = 'red'; label = `${label} · ${failed} ${t('failed')}`; }

  async function sendNow() {
    setBusy(true);
    try {
      if (await probe()) await sendDrafts({ userId: user.id });
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry) {
    const what = entry.kind === 'sale' ? t('this bill') : t('this quotation');
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${t('Remove')} ${what}? ${t('It will not be sent to the server.')}`)) return;
    await removeDraft(entry.id);
  }

  return (
    <>
      <button type="button" className={`status sync-status ${tone}`} onClick={() => setOpen(true)} title={t('Sync status')}>
        <span className="dot" />{label}
      </button>
      {online && !serverSession && (
        <button type="button" className="btn btn-primary btn-sm" onClick={onSignInAgain}>{t('Connected · sign in to send')}</button>
      )}
      {open && (
        <Modal wide title={t('Sync status')} description={t('Bills and quotations saved on this device without a connection are sent automatically when it returns.')} onClose={() => setOpen(false)}>
          <div className="sync-summary">
            <span className={`status ${online ? '' : 'red'}`}><span className="dot" />{t(online ? 'Connected to the server' : 'No connection to the server')}</span>
            {!serverSession && <span className="muted small-note">{t('Signed in offline. Sign in again while connected to send your drafts.')}</span>}
            {others.length > 0 && <span className="muted small-note">{others.length} {t('draft(s) from other staff wait for them to sign in on this device.')}</span>}
          </div>
          <div className="table-wrap sync-table">
            <table>
              <thead><tr>{['Saved', 'Type', 'Customer', 'Total', 'Status', ''].map((heading) => <th key={heading || 'actions'}>{heading && t(heading)}</th>)}</tr></thead>
              <tbody>
                {mine.length === 0 && <tr><td colSpan="6"><div className="empty">{t('Nothing is waiting. Everything is saved on the server.')}</div></td></tr>}
                {mine.slice().reverse().map((entry) => (
                  <tr key={entry.id}>
                    <td>{when(entry.createdAt)}</td>
                    <td>{t(entry.kind === 'sale' ? 'Bill' : 'Quotation')}</td>
                    <td>{entry.summary?.customer || t('Walk-in Customer')}</td>
                    <td>{entry.summary?.total !== undefined ? money(entry.summary.total) : '—'}</td>
                    <td>
                      <span className={`status ${STATUS_TONE[entry.status]}`}><span className="dot" />{t(STATUS_LABEL[entry.status])}{entry.result?.number ? ` · ${entry.result.number}` : ''}</span>
                      {entry.error && <div className="form-error sync-error">{t(entry.error)}</div>}
                      {entry.note && <div className="muted small-note">{t(entry.note)}</div>}
                    </td>
                    <td className="sync-actions">
                      {entry.status === 'failed' && <button type="button" className="btn btn-outline btn-sm" disabled={!online || !serverSession} onClick={() => retryDraft(entry.id, { userId: user.id })}>{t('Try again')}</button>}
                      {entry.status === 'failed' && entry.kind === 'sale' && onOpenInPos && <button type="button" className="btn btn-outline btn-sm" onClick={() => { setOpen(false); onOpenInPos(entry); }}>{t('Open in POS')}</button>}
                      {(entry.status === 'failed' || entry.status === 'sent') && <button type="button" className="btn btn-outline btn-sm" onClick={() => remove(entry)}>{t(entry.status === 'sent' ? 'Clear' : 'Remove')}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="modal-actions-row">
            <button type="button" className="btn btn-outline" onClick={() => setOpen(false)}>{t('Close')}</button>
            <button type="button" className="btn btn-primary" disabled={busy || !serverSession || waiting === 0} onClick={sendNow}>{busy ? t('Sending…') : t('Send now')}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
