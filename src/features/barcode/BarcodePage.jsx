import { useState } from 'react';
import { can } from '../../app/access.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import LabelsTab from './LabelsTab.jsx';
import ScanTab from './ScanTab.jsx';
import BarcodeScanner from '../../scanner/BarcodeScanner.jsx';

export default function BarcodePage({ user }) {
  const { t } = useI18n();
  const showLabels = can(user, 'barcode.labels');
  const [tab, setTab] = useState('scan');

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Barcode scanner')}</h1>
          <p>{t('Scan with the device camera, a USB/Bluetooth scanner, or type a code. Look up price and stock instantly.')}</p>
        </div>
      </div>
      <div className="tabs">
        <button type="button" className={tab === 'scan' ? 'active' : ''} onClick={() => setTab('scan')}>{t('Scan')}</button>
        <button type="button" className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>{t('AI scanner')}</button>
        {showLabels && <button type="button" className={tab === 'labels' ? 'active' : ''} onClick={() => setTab('labels')}>{t('Barcode labels')}</button>}
      </div>
      {tab === 'ai' ? <BarcodeScanner /> : tab === 'labels' ? <LabelsTab /> : <ScanTab user={user} />}
    </>
  );
}
