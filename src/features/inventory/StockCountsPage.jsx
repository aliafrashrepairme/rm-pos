import { useI18n } from '../../i18n/I18nProvider.jsx';
import CountsTab from './CountsTab.jsx';

export default function StockCountsPage({ user }) {
  const { t } = useI18n();
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Stock counts')}</h1>
          <p>{t('Count the shelves, scan barcodes, and submit the count for a Manager to approve.')}</p>
        </div>
      </div>
      <CountsTab user={user} />
    </>
  );
}
