import { useState } from 'react';
import ReportsDashboard from './ReportsDashboard.jsx';
import SalesReport from './SalesReport.jsx';
import InventoryReport from './InventoryReport.jsx';
import PaymentReport from './PaymentReport.jsx';
import '../styles/reports.css';

const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', Component: ReportsDashboard },
  { key: 'sales', label: 'Sales Reports', Component: SalesReport },
  { key: 'inventory', label: 'Inventory Reports', Component: InventoryReport },
  { key: 'payments', label: 'Payment Reports', Component: PaymentReport }
];

export default function ReportsModule() {
  const [section, setSection] = useState('dashboard');
  const Active = SECTIONS.find((s) => s.key === section)?.Component || ReportsDashboard;

  return (
    <div className="rpt-page">
      <div className="rpt-tabs">
        {SECTIONS.map((s) => (
          <button key={s.key} className={section === s.key ? 'active' : ''} onClick={() => setSection(s.key)} type="button">
            {s.label}
          </button>
        ))}
      </div>
      <Active />
    </div>
  );
}
