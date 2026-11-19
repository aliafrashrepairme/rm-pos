import { useI18n } from '../../i18n/I18nProvider.jsx';
import AdjustmentsTab from './AdjustmentsTab.jsx';

export default function StockAdjustmentsPage() {
  const { t } = useI18n();
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Stock adjustments')}</h1>
          <p>{t('Correct stock for damage, loss or found items. Stock changes as soon as the adjustment is saved.')}</p>
        </div>
      </div>
      <AdjustmentsTab />
    </>
  );
}
