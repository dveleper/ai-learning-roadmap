// Account caches and pending writes are independent of the original browser backup.
function startProgressSync({ client, dates, legacyKey, readState, showState, status, signedIn }) {
  let account = null;
  let running = false;
  let rerun = false;
  const empty = () => ({ done: {}, logs: {} });
  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  };
  const cache = id => legacyKey + ':' + id;
  const outbox = id => cache(id) + ':pending:';
  const pending = id => Object.keys(localStorage).filter(key => key.startsWith(outbox(id)))
    .map(key => ({ key, ...read(key, {}) }))
    .filter(item => item.patch)
    .sort((a, b) => a.created - b.created || a.key.localeCompare(b.key));
  let lastQueued = 0;
  const redirectTo = 'https://dveleper.github.io/ai-learning-roadmap/';

  function enqueue(patches) {
    if (!account || !patches.length) return;
    try {
      for (const patch of patches) {
        lastQueued = Math.max(Date.now(), lastQueued + 1);
        localStorage.setItem(outbox(account.id) + crypto.randomUUID(),
          JSON.stringify({ patch, created: lastQueued }));
      }
      void sync();
    } catch {
      status('No se pudo preparar la sincronización. Exporta un respaldo del navegador.');
    }
  }

  function patch(date, completed, log, importing = false) {
    return {
      p_class_date: date,
      p_completed: completed,
      p_save_log: Boolean(log),
      p_evaluation: /^[1-5]$/.test(log?.score) ? Number(log.score) : null,
      p_notes: typeof log?.notes === 'string' ? log.notes.slice(0, 10000) : '',
      p_import: importing
    };
  }

  function importProgress(source) {
    enqueue(dates.filter(date => Object.hasOwn(source.done || {}, date) || source.logs?.[date])
      .map(date => patch(date,
        Object.hasOwn(source.done || {}, date) ? Boolean(source.done[date]) : null,
        source.logs?.[date], true)));
  }

  async function sync() {
    if (!account) return;
    if (running) { rerun = true; return; }
    running = true;
    const id = account.id;
    try {
      status('Sincronizando…');
      const upload = async () => {
        for (const item of pending(id)) {
          if (account?.id !== id) return;
          const { error } = await client.rpc('save_learning_progress', item.patch);
          if (error) throw error;
          localStorage.removeItem(item.key);
        }
      };
      if (navigator.locks) await navigator.locks.request(outbox(id), upload);
      else await upload();
      if (account?.id !== id) return;
      const { data, error } = await client.from('learning_progress')
        .select('class_date,completed,evaluation,notes,updated_at,completion_saved,log_saved')
        .eq('user_id', id);
      if (error) throw error;
      if (account?.id !== id || pending(id).length) return;
      const next = empty();
      for (const row of data) {
        if (row.completion_saved) next.done[row.class_date] = row.completed;
        if (row.log_saved) next.logs[row.class_date] = {
          score: row.evaluation == null ? '' : String(row.evaluation),
          notes: row.notes,
          updated: row.updated_at
        };
      }
      localStorage.setItem(cache(id), JSON.stringify(next));
      showState(next);
      status('Progreso sincronizado.');
    } catch {
      if (account?.id === id) status('Sin conexión con Supabase. El progreso local se conserva. Puedes reintentar.');
    } finally {
      running = false;
      if (rerun) { rerun = false; void sync(); }
    }
  }

  client.auth.onAuthStateChange((event, session) => {
    const user = session?.user || null;
    if (event !== 'INITIAL_SESSION' && user?.id === account?.id) return;
    account = user;
    showState(read(user ? cache(user.id) : legacyKey, empty()));
    const local = read(legacyKey, empty());
    signedIn(user, Boolean(user && (Object.keys(local.done || {}).length ||
      Object.keys(local.logs || {}).length)));
    if (user) setTimeout(sync, 0);
    else status('Avances guardados en este navegador.');
  });
  window.addEventListener('online', sync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sync();
  });
  return {
    storageKey: () => account ? cache(account.id) : legacyKey,
    active: () => Boolean(account),
    saveCompletion: date => enqueue([patch(date, readState().done[date], null)]),
    saveLog: date => enqueue([patch(date, null, readState().logs[date])]),
    importProgress,
    importLocal: () => importProgress(read(legacyKey, empty())),
    sync,
    signIn: () => client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } }),
    signOut: () => client.auth.signOut({ scope: 'local' })
  };
}


// Refresh through the existing sync queue when the signed-in user's rows change.
const startProgressSyncWithoutRealtime = startProgressSync;
startProgressSync = function (options) {
  const progress = startProgressSyncWithoutRealtime(options);
  const { client } = options;
  let watchedUser;
  let channel;
  let refreshTimer;
  client.auth.onAuthStateChange((event, session) => {
    const userId = session?.user?.id;
    if (watchedUser === userId) return;
    watchedUser = userId;
    clearTimeout(refreshTimer);
    const previous = channel;
    channel = undefined;
    setTimeout(() => {
      if (previous) void client.removeChannel(previous);
      if (!userId || watchedUser !== userId || channel) return;
      const subscription = client.channel('learning-progress:' + userId);
      channel = subscription;
      const refresh = () => {
        if (channel !== subscription || watchedUser !== userId) return;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(progress.sync, 150);
      };
      const filter = { schema: 'public', table: 'learning_progress', filter: 'user_id=eq.' + userId };
      subscription.on('postgres_changes', { ...filter, event: 'INSERT' }, refresh)
        .on('postgres_changes', { ...filter, event: 'UPDATE' }, refresh)
        .subscribe(result => {
          if (result === 'SUBSCRIBED') refresh();
        });
    }, 0);
  });
  return progress;
};
