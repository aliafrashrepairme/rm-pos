import { useI18n } from '../i18n/I18nProvider.jsx';

export default function Pager({ page, pageSize, total, onPage }) {
  const { t } = useI18n();
  const lastPage = Math.max(Math.ceil(total / pageSize), 1);
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  return (
    <div className="pager">
      <span>{first}–{last} / {total}</span>
      <button type="button" className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ {t('Previous')}</button>
      <button type="button" className="btn btn-outline btn-sm" disabled={page >= lastPage} onClick={() => onPage(page + 1)}>{t('Next')} ›</button>
    </div>
  );
}
