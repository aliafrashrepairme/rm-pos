export default function ReportStatCard({ label, value, icon, footnote }) {
  return (
    <div className="card rpt-stat">
      <div className="rpt-stat-top">
        <span>{label}</span>
        {icon && <span className="rpt-stat-icon">{icon}</span>}
      </div>
      <div className="rpt-stat-value">{value}</div>
      {footnote && <div className="rpt-stat-foot">{footnote}</div>}
    </div>
  );
}
