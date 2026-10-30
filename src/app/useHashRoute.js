import { useCallback, useEffect, useState } from 'react';
import { screenFromSlug, slugFor } from './access.js';

function currentSlug() {
  return window.location.hash.replace(/^#\/?/, '');
}

// Keeps the open screen in the address, so refresh and back work inside Electron's file:// page.
export function useHashRoute() {
  const [slug, setSlug] = useState(currentSlug);

  useEffect(() => {
    const changed = () => setSlug(currentSlug());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  const navigate = useCallback((name) => {
    window.location.hash = name ? `/${slugFor(name)}` : '';
  }, []);

  return { slug, screen: screenFromSlug(slug), navigate };
}
