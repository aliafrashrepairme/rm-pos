import { useMemo, useState } from 'react';

const PAGE_SIZE = 10;

export default function ReportTable({ columns, rows, emptyMessage = 'No data for the selected filters.' }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(1);

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    const getValue = col?.sortValue || col?.value;
    return [...rows].sort((a, b) => {
      const av = typeof getValue === 'function' ? getValue(a) : a[getValue];
      const bv = typeof getValue === 'function' ? getValue(b) : b[getValue];
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [rows, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const pageRows = sortedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const safePage = Math.min(page, totalPages);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(1);
  }

  if (rows.length === 0) {
    return <div className="card rpt-table-empty">{emptyMessage}</div>;
  }

  return (
    <div className="card rpt-table-wrap">
      <table className="rpt-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} onClick={() => col.sortable !== false && toggleSort(col.key)} className={col.sortable !== false ? 'sortable' : ''}>
                {col.label}
                {sortKey === col.key && <span className="rpt-sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, i) => (
            <tr key={row.id || row.orderId || row.transactionId || i}>
              {columns.map((col) => (
                <td key={col.key}>{typeof col.value === 'function' ? col.value(row) : row[col.value]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="rpt-pagination">
          <button className="btn-outline" disabled={safePage <= 1} onClick={() => setPage((p) => p - 1)} type="button">← Prev</button>
          <span>Page {safePage} of {totalPages}</span>
          <button className="btn-outline" disabled={safePage >= totalPages} onClick={() => setPage((p) => p + 1)} type="button">Next →</button>
        </div>
      )}
    </div>
  );
}
