import { money, quantity } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import { useI18n } from '../../i18n/I18nProvider.jsx';

export default function SummaryTab() {
  const { t } = useI18n();
  const { data, error } = useListRequest('/api/inventory/summary');
  const summary = data?.summary;

  if (error) return <p className="form-error" role="alert">{t(error)}</p>;
  if (!summary) return <div className="card"><div className="empty">{t('Loading…')}</div></div>;

  return (
    <>
      <div className="sum-strip">
        <div><span className="sl">{t('Stock value')}</span><b>{money(summary.costValue)}</b><small>{t('At cost price')}</small></div>
        <div><span className="sl">{t('Value at retail')}</span><b>{money(summary.retailValue)}</b><small>{t('At selling price')}</small></div>
        <div><span className="sl">{t('Total products')}</span><b>{quantity(summary.products)}</b><small>{quantity(summary.units)} {t('units')}</small></div>
        <div><span className="sl">{t('Low Stock')}</span><b>{summary.low}</b><small>{summary.out} {t('Out of Stock')}</small></div>
      </div>
      <div className="card dash-gap">
        <h3>{t('Stock value by category')}</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>{['Category', 'Products', 'Units', 'Value (cost)', 'Value at retail', 'Low Stock', 'Out of Stock'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr>
            </thead>
            <tbody>
              {summary.categories.length === 0 && <tr><td colSpan="7"><div className="empty">{t('No records found.')}</div></td></tr>}
              {summary.categories.map((row) => (
                <tr key={row.category}>
                  <td><b>{row.category}</b></td>
                  <td>{row.products}</td>
                  <td>{quantity(row.units)}</td>
                  <td>{money(row.costValue)}</td>
                  <td>{money(row.retailValue)}</td>
                  <td>{row.low}</td>
                  <td>{row.out}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
