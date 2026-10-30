import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Loads a list for the given address. A slow reply to an earlier address can't replace a newer one.
export function useListRequest(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    try {
      const result = await api(path);
      if (request !== latest.current) return;
      setData(result);
      setError('');
    } catch (failure) {
      if (request === latest.current) setError(failure.message);
    }
  }, [path]);

  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}

export function useDebounced(value, delayMs = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
