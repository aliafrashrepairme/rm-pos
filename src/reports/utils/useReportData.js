import { useEffect, useMemo, useState } from 'react';
import { useListRequest } from '../../app/useListRequest.js';

export function usePeriod(initial) {
  const [preset, setPreset] = useState(initial);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  return useMemo(() => ({
    preset, setPreset, from, setFrom, to, setTo,
    reset: () => { setPreset(initial); setFrom(''); setTo(''); },
    params: { preset, ...(preset === 'custom' ? { from, to } : {}) }
  }), [preset, from, to, initial]);
}

export function queryString(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) query.set(key, value);
  }
  return query.toString();
}

export function useFilterOptions() {
  return useListRequest('/api/reports/filters').data;
}

// One server page of a long report, with its sort order.
export function usePagedReport(path, params) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('date');
  const [dir, setDir] = useState('desc');
  const filter = queryString(params);
  useEffect(() => { setPage(1); }, [filter, sort, dir]);
  const { data, error } = useListRequest(`${path}?${queryString({ ...params, page, sort, dir })}`);
  return {
    data,
    error,
    page,
    setPage,
    sort,
    dir,
    onSort: (key) => {
      setDir(sort === key && dir === 'desc' ? 'asc' : 'desc');
      setSort(key);
    },
    allPath: `${path}?${queryString({ ...params, sort, dir, all: 1 })}`
  };
}
