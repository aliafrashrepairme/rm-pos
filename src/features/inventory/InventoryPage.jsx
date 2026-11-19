import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import MovementsTab from './MovementsTab.jsx';
import StockTab from './StockTab.jsx';
import SummaryTab from './SummaryTab.jsx';

export default function InventoryPage({ user }) {
  const { t } = useI18n();
  const tabs = [
    { key: 'stock', label: 'Current stock', Component: StockTab },
    { key: 'movements', label: 'Stock movements', Component: MovementsTab },
    { key: 'summary', label: 'Stock value', Component: SummaryTab }
  ];
  const [active, setActive] = useState('stock');
  const Current = tabs.find((tab) => tab.key === active)?.Component ?? StockTab;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Inventory')}</h1>
        </div>
      </div>
      <div className="tabs">
        {tabs.map((tab) => (
          <button type="button" key={tab.key} className={tab.key === active ? 'active' : ''} onClick={() => setActive(tab.key)}>{t(tab.label)}</button>
        ))}
      </div>
      <Current user={user} />
    </>
  );
}
