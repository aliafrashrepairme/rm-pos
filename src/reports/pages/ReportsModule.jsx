import { useState } from 'react';
import { can } from '../../app/access.js';
import ReportsDashboard from './ReportsDashboard.jsx';
import SalesReport from './SalesReport.jsx';
import InventoryReport from './InventoryReport.jsx';
import PaymentReport from './PaymentReport.jsx';
import '../styles/reports.css';

const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', Component: ReportsDashboard, needs: ['reports.sales', 'reports.inventory'] },
  { key: 'sales', label: 'Sales Reports', Component: SalesReport, needs: ['reports.sales'] },
  { key: 'inventory', label: 'Inventory Reports', Component: InventoryReport, needs: ['reports.inventory'] },
  { key: 'payments', label: 'Payment Reports', Component: PaymentReport, needs: ['reports.sales'] }
];

export default function ReportsModule({ user }) {
  const allowed = SECTIONS.filter((section) => section.needs.every((permission) => can(user, permission)));
  const [section, setSection] = useState(allowed[0]?.key);
  const Active = allowed.find((s) => s.key === section)?.Component;

  return (
    <div className="rpt-page">
      <div className="rpt-tabs">
        {allowed.map((s) => (
          <button key={s.key} className={section === s.key ? 'active' : ''} onClick={() => setSection(s.key)} type="button">
            {s.label}
          </button>
        ))}
      </div>
      {Active && <Active />}
    </div>
  );
}
