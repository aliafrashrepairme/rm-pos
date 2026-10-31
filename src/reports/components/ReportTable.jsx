import { useMemo, useState } from 'react';
import Pager from '../../components/Pager.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const PAGE_SIZE = 25;

export function TableView({ columns, rows, sort, dir, onSort, empty, loading }) {
  const { t } = useI18n();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => {
              const sortKey = column.sort;
              return (
                <th key={column.key} aria-sort={sort === sortKey && sortKey ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {sortKey
                    ? <button type="button" className="rpt-sort" onClick={() => onSort(sortKey)}>{column.label}{sort === sortKey && <span className="rpt-sort-arrow">{dir === 'asc' ? ' ▲' : ' ▼'}</span>}</button>
                    : column.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={columns.length}><div className="empty">{t('Loading…')}</div></td></tr>}
          {!loading && rows.length === 0 && <tr><td colSpan={columns.length}><div className="empty">{empty ?? t('No records found.')}</div></td></tr>}
          {!loading && rows.map((row, index) => (
            <tr key={row.id ?? row.productId ?? row.category ?? row.date ?? index}>
              {columns.map((column) => <td key={column.key}>{column.value(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// For reports already fully loaded: sorts and pages on this computer.
export default function ReportTable({ columns, rows, empty }) {
  const [sort, setSort] = useState(null);
  const [dir, setDir] = useState('asc');
  const [page, setPage] = useState(1);

  const ordered = useMemo(() => {
    const column = columns.find((item) => item.sort === sort);
    if (!column) return rows;
    const read = column.csv ?? column.value;
    return [...rows].sort((a, b) => {
      const [left, right] = [read(a), read(b)];
      const order = typeof left === 'number' ? left - right : String(left).localeCompare(String(right));
      return dir === 'asc' ? order : -order;
    });
  }, [rows, columns, sort, dir]);

  function onSort(key) {
    setDir(sort === key && dir === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setPage(1);
  }

  const lastPage = Math.max(Math.ceil(ordered.length / PAGE_SIZE), 1);
  const safePage = Math.min(page, lastPage);
  return (
    <>
      <TableView columns={columns} rows={ordered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)} sort={sort} dir={dir} onSort={onSort} empty={empty} />
      {ordered.length > PAGE_SIZE && <Pager page={safePage} pageSize={PAGE_SIZE} total={ordered.length} onPage={setPage} />}
    </>
  );
}
