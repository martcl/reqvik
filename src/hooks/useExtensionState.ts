import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../client';

// A stable loader lets each page add its own data (for example, the active tab).
export function useExtensionState<T>(load: () => Promise<T>) {
  const [state, setState] = useState<T>();
  const [error, setError] = useState('');
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++request.current;
    try {
      const next = await load();
      if (version === request.current) setState(next);
      return next;
    } catch (error) {
      if (version === request.current) setError(errorMessage(error));
      throw error;
    }
  }, [load]);

  useEffect(() => {
    const changed = () => {
      void refresh().catch(() => {});
    };
    changed();
    chrome.storage.onChanged.addListener(changed);
    return () => {
      chrome.storage.onChanged.removeListener(changed);
      request.current++;
    };
  }, [refresh]);

  return { state, refresh, error, setError };
}
