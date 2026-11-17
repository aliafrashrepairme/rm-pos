import { useState } from 'react';
import { api } from '../../api.js';
import Modal from '../../components/Modal.jsx';
import Status from '../../components/Status.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

export default function CategoriesModal({ categories, onChanged, onClose }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editedName, setEditedName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action) {
    setError('');
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const add = (event) => {
    event.preventDefault();
    run(async () => {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
    });
  };

  const save = (category, changes) => run(async () => {
    await api(`/api/categories/${category.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
    setEditingId(null);
  });

  return (
    <Modal title={t('Product categories')} onClose={onClose}>
      <form className="inline-add" onSubmit={add}>
        <input className="inp" aria-label={t('New category name')} placeholder={t('New category name')} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoFocus />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>＋ {t('Add')}</button>
      </form>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="modal-scroll">
        {categories.length === 0 && <div className="empty">{t('No records found.')}</div>}
        {categories.map((category) => (
          <div className="category-row" key={category.id}>
            {editingId === category.id ? (
              <>
                <input className="inp grow" aria-label={t('Category')} value={editedName} onChange={(event) => setEditedName(event.target.value)} maxLength={80} autoFocus />
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => save(category, { name: editedName })}>{t('Save')}</button>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditingId(null)}>{t('Cancel')}</button>
              </>
            ) : (
              <>
                <span className="grow"><b>{category.name}</b></span>
                {!category.active && <Status value="Inactive" label={t('Inactive')} />}
                <button type="button" className="btn btn-outline btn-sm" onClick={() => { setEditingId(category.id); setEditedName(category.name); }}>{t('Edit')}</button>
                <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => save(category, { active: !category.active })}>{t(category.active ? 'Deactivate' : 'Reactivate')}</button>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('Close')}</button>
      </div>
    </Modal>
  );
}
