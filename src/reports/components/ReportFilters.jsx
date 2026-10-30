const PRESET_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 Days',
  last30: 'Last 30 Days',
  thisMonth: 'This Month',
  lastMonth: 'Last Month',
  thisYear: 'This Year',
  custom: 'Custom Range'
};

export default function ReportFilters({
  preset,
  onPresetChange,
  customRange,
  onCustomRangeChange,
  category,
  categories,
  onCategoryChange,
  paymentMethod,
  paymentMethods,
  onPaymentMethodChange,
  search,
  onSearchChange,
  onApply,
  onReset
}) {
  return (
    <div className="card rpt-filters">
      <div className="rpt-filters-row">
        <label>
          Date range
          <select value={preset} onChange={(e) => onPresetChange(e.target.value)}>
            {Object.entries(PRESET_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>

        {preset === 'custom' && (
          <>
            <label>
              Start date
              <input type="date" value={customRange.start || ''} onChange={(e) => onCustomRangeChange({ ...customRange, start: e.target.value })} />
            </label>
            <label>
              End date
              <input type="date" value={customRange.end || ''} onChange={(e) => onCustomRangeChange({ ...customRange, end: e.target.value })} />
            </label>
          </>
        )}

        {categories && (
          <label>
            Category
            <select value={category} onChange={(e) => onCategoryChange(e.target.value)}>
              <option value="All">All Categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}

        {paymentMethods && (
          <label>
            Payment method
            <select value={paymentMethod} onChange={(e) => onPaymentMethodChange(e.target.value)}>
              <option value="All">All Methods</option>
              {paymentMethods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}

        {onSearchChange && (
          <label className="rpt-filters-search">
            Search
            <input type="text" placeholder="Search..." value={search} onChange={(e) => onSearchChange(e.target.value)} />
          </label>
        )}
      </div>

      <div className="rpt-filters-actions">
        <button className="btn-outline" onClick={onReset} type="button">Reset Filters</button>
        <button className="btn-primary" onClick={onApply} type="button">Apply Filters</button>
      </div>
    </div>
  );
}
