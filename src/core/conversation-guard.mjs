// This single-writer process owns admission. Native execution and guidance share
// a conversation; cleanup is exclusive. Persisted activity must additionally be
// checked while holding cleanup ownership to protect runs from before restart.
export function createConversationGuard() {
  const entries = new Map();
  function entry(id) {
    if (!entries.has(id)) entries.set(id, { native: 0, cleanup: false, release: null, wait: null });
    return entries.get(id);
  }
  function prune(id, state) { if (!state.native && !state.cleanup) entries.delete(id); }
  return {
    async native(id, operation) {
      const state = entry(id);
      state.native++; // Reserve before awaiting so a queued native job wins next.
      try { if (state.cleanup) await state.wait; return await operation(); }
      finally { state.native--; prune(id, state); }
    },
    async cleanup(id, operation) {
      const state = entry(id);
      if (state.native || state.cleanup) return false;
      state.cleanup = true;
      state.wait = new Promise(resolve => { state.release = resolve; });
      try { await operation(); return true; }
      finally { state.cleanup = false; state.release(); state.wait = null; state.release = null; prune(id, state); }
    },
  };
}
