import { createContext, useContext, useCallback, useMemo } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage.js';
import { ALL_SLOTS, PREF, FULL_HOURS } from '../constants/schedule.js';
import { makePair, pairKey } from '../lib/pair.js';

const ResponderContext = createContext(null);

function emptyPrefs() {
  const prefs = {};
  for (const id of ALL_SLOTS) prefs[id] = PREF.UNAVAIL;
  return prefs;
}

export function makeResponder(partial = {}) {
  return {
    id: partial.id || `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: partial.name || '',
    role: partial.role || 'rookie',
    bilingual: partial.bilingual || false,
    gender: partial.gender || 'unspecified',
    hours: partial.hours || FULL_HOURS,
    prefs: partial.prefs || emptyPrefs(),
  };
}

export function ResponderProvider({ children }) {
  const [responders, setResponders, resetResponders] = useLocalStorage('vcrt:responders', []);
  const [avoidancePairs, setAvoidancePairs, resetPairs] = useLocalStorage(
    'vcrt:avoidance-pairs',
    []
  );
  const [preferredPairs, setPreferredPairs, resetPreferredPairs] = useLocalStorage(
    'vcrt:preferred-pairs',
    []
  );

  const addResponder = useCallback(
    (responder) => setResponders((prev) => [...prev, responder]),
    [setResponders]
  );
  const updateResponder = useCallback(
    (id, patch) =>
      setResponders((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r))),
    [setResponders]
  );
  const removeResponder = useCallback(
    (id) => {
      setResponders((prev) => prev.filter((r) => r.id !== id));
      // Drop any pairing rule that references a removed responder.
      setAvoidancePairs((prev) => prev.filter((p) => p[0] !== id && p[1] !== id));
      setPreferredPairs((prev) => prev.filter((p) => p[0] !== id && p[1] !== id));
    },
    [setResponders, setAvoidancePairs, setPreferredPairs]
  );
  const clearAll = useCallback(() => {
    resetResponders();
    resetPairs();
    resetPreferredPairs();
  }, [resetResponders, resetPairs, resetPreferredPairs]);
  const loadAll = useCallback(
    (list, pairs = [], prefPairs = []) => {
      setResponders(list);
      setAvoidancePairs(pairs);
      setPreferredPairs(prefPairs);
    },
    [setResponders, setAvoidancePairs, setPreferredPairs]
  );

  // Avoidance pair CRUD.
  const addAvoidancePair = useCallback(
    (a, b) => {
      if (!a || !b || a === b) return;
      const pair = makePair(a, b);
      const key = pairKey(pair);
      setAvoidancePairs((prev) =>
        prev.some((p) => pairKey(p) === key) ? prev : [...prev, pair]
      );
    },
    [setAvoidancePairs]
  );
  const removeAvoidancePair = useCallback(
    (a, b) => {
      const key = pairKey(makePair(a, b));
      setAvoidancePairs((prev) => prev.filter((p) => pairKey(p) !== key));
    },
    [setAvoidancePairs]
  );

  // Preferred ("schedule together") pair CRUD.
  const addPreferredPair = useCallback(
    (a, b) => {
      if (!a || !b || a === b) return;
      const pair = makePair(a, b);
      const key = pairKey(pair);
      setPreferredPairs((prev) =>
        prev.some((p) => pairKey(p) === key) ? prev : [...prev, pair]
      );
    },
    [setPreferredPairs]
  );
  const removePreferredPair = useCallback(
    (a, b) => {
      const key = pairKey(makePair(a, b));
      setPreferredPairs((prev) => prev.filter((p) => pairKey(p) !== key));
    },
    [setPreferredPairs]
  );

  const value = useMemo(
    () => ({
      responders,
      avoidancePairs,
      preferredPairs,
      addResponder,
      updateResponder,
      removeResponder,
      addAvoidancePair,
      removeAvoidancePair,
      addPreferredPair,
      removePreferredPair,
      clearAll,
      loadAll,
    }),
    [
      responders,
      avoidancePairs,
      preferredPairs,
      addResponder,
      updateResponder,
      removeResponder,
      addAvoidancePair,
      removeAvoidancePair,
      addPreferredPair,
      removePreferredPair,
      clearAll,
      loadAll,
    ]
  );

  return <ResponderContext.Provider value={value}>{children}</ResponderContext.Provider>;
}

export function useResponders() {
  const ctx = useContext(ResponderContext);
  if (!ctx) throw new Error('useResponders must be used within a ResponderProvider');
  return ctx;
}

export { emptyPrefs };
