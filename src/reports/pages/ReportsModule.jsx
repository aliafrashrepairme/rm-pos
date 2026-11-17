import { useState } from 'react';
import { can } from '../../app/access.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import InventoryReport from './InventoryReport.jsx';
import PaymentReport from './PaymentReport.jsx';
import ReportsDashboard from './ReportsDashboard.jsx';
import SalesReport from './SalesReport.jsx';
import '../styles/reports.css';

const SECTIONS = [
  { key: 'dashboard', label: 'Reports dashboard', Component: ReportsDashboard, needs: ['reports.sales', 'reports.inventory'] },
  { key: 'sales', label: 'Sales reports', Component: SalesReport, needs: ['reports.sales'] },
  { key: 'inventory', label: 'Inventory reports', Component: InventoryReport, needs: ['reports.inventory'] },
  { key: 'payments', label: 'Payment reports', Component: PaymentReport, needs: ['reports.sales'] }
];

export default function ReportsModule({ user }) {
  const { t } = useI18n();
  const allowed = SECTIONS.filter((section) => section.needs.every((permission) => can(user, permission)));
  const [section, setSection] = useState(allowed[0]?.key);
  const Active = allowed.find((item) => item.key === section)?.Component;

  return (
    <div className="rpt-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Reports')}</h1>
          <p>{t('Sales and stock reports from your real records.')}</p>
        </div>
      </div>
      <div className="tabs">
        {allowed.map((item) => (
          <button key={item.key} type="button" className={section === item.key ? 'active' : ''} onClick={() => setSection(item.key)}>{t(item.label)}</button>
        ))}
      </div>
      {Active && <Active key={section} user={user} />}
    </div>
  );
}
