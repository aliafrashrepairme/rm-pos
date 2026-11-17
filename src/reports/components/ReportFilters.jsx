import { useI18n } from '../../i18n/I18nProvider.jsx';

const PRESETS = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  thisYear: 'This year',
  custom: 'Custom range'
};

// Each filter appears only when its value and change handler are passed. Changes apply straight away.
export default function ReportFilters({ period, category, categories, onCategory, product, products, onProduct, method, methods, onMethod, type, types, onType, typeLabel = 'Type', allTypesLabel = 'All types', search, onSearch, onReset }) {
  const { t } = useI18n();
  return (
    <div className="card rpt-filters">
      <div className="rpt-filters-row">
        {period && (
          <label>
            {t('Date range')}
            <select name="preset" value={period.preset} onChange={(event) => period.setPreset(event.target.value)}>
              {Object.entries(PRESETS).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
            </select>
          </label>
        )}
        {period?.preset === 'custom' && (
          <>
            <label>{t('Start date')}<input name="from" type="date" value={period.from} onChange={(event) => period.setFrom(event.target.value)} /></label>
            <label>{t('End date')}<input name="to" type="date" value={period.to} onChange={(event) => period.setTo(event.target.value)} /></label>
          </>
        )}
        {categories && (
          <label>
            {t('Category')}
            <select name="category" value={category} onChange={(event) => onCategory(event.target.value)}>
              <option value="">{t('All categories')}</option>
              {categories.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )}
        {products && (
          <label>
            {t('Product')}
            <select name="product" value={product} onChange={(event) => onProduct(event.target.value)}>
              <option value="">{t('All products')}</option>
              {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        )}
        {methods && (
          <label>
            {t('Payment method')}
            <select name="method" value={method} onChange={(event) => onMethod(event.target.value)}>
              <option value="">{t('All methods')}</option>
              {methods.map((name) => <option key={name} value={name}>{t(name)}</option>)}
            </select>
          </label>
        )}
        {types && (
          <label>
            {t(typeLabel)}
            <select name="type" value={type} onChange={(event) => onType(event.target.value)}>
              <option value="">{t(allTypesLabel)}</option>
              {types.map((name) => <option key={name} value={name}>{t(name)}</option>)}
            </select>
          </label>
        )}
        {onSearch && (
          <label className="rpt-filters-search">
            {t('Search')}
            <input name="reportSearch" type="text" value={search} onChange={(event) => onSearch(event.target.value)} />
          </label>
        )}
        <button type="button" className="btn btn-outline btn-sm rpt-reset" onClick={onReset}>{t('Reset filters')}</button>
      </div>
    </div>
  );
}
