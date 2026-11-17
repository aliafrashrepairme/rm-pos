import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const REFRESH_MS = 30000;

// Loads a list for the given address. A slow reply to an earlier address can't replace a newer one.
// While the screen is in view it reloads every half minute and when the window comes back,
// so sales and stock changes made at other tills appear without anyone pressing refresh.
export function useListRequest(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const latest = useRef(0);
  const waiting = useRef(0);

  const load = useCallback(async (background) => {
    // A background refresh never overtakes a load that is still on its way.
    if (background && waiting.current) return;
    const request = ++latest.current;
    waiting.current += 1;
    try {
      const result = await api(path);
      if (request !== latest.current) return;
      setData(result);
      setError('');
    } catch (failure) {
      // A missed background refresh keeps the list on screen; the next one tries again.
      if (request === latest.current && !background) setError(failure.message);
    } finally {
      waiting.current -= 1;
    }
  }, [path]);

  const reload = useCallback(() => load(false), [load]);

  useEffect(() => {
    load(false);
    const refresh = () => {
      if (!document.hidden) load(true);
    };
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

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
