import { useState } from 'react';
import { can } from '../../app/access.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import LabelsTab from './LabelsTab.jsx';
import BarcodeScanner from '../../scanner/BarcodeScanner.jsx';

// The AI scanner is the one scanning screen; stock counts have their own scan box in Inventory.
export default function BarcodePage({ user }) {
  const { t } = useI18n();
  const showLabels = can(user, 'barcode.labels');
  const [tab, setTab] = useState('ai');

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Barcode scanner')}</h1>
          <p>{t('Scan with the device camera, a USB/Bluetooth scanner, or type a code. Look up price and stock instantly.')}</p>
        </div>
      </div>
      {showLabels && (
        <div className="tabs">
          <button type="button" className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>{t('AI scanner')}</button>
          <button type="button" className={tab === 'labels' ? 'active' : ''} onClick={() => setTab('labels')}>{t('Barcode labels')}</button>
        </div>
      )}
      {showLabels && tab === 'labels' ? <LabelsTab /> : <BarcodeScanner user={user} />}
    </>
  );
}
