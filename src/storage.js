(() => {
  const store = 'character';
  const record = 'current';
  const oldKey = 'maple-atlas-progress-v1';
  const status = message => {
    for (const id of ['mc-save-status', 'mc-journal-storage']) {
      const el = document.getElementById(id);
      if (el) el.textContent = message;
    }
  };
  const app = document.getElementById('maple-atlas-concept');
  const development = app.dataset.channel === 'dev';
  app.inert = true;
  status('Opening local progress…');
  let database;
  let writeQueue = Promise.resolve();
  const open = new Promise((resolve, reject) => {
    const request = indexedDB.open(development ? 'maple-atlas-dev' : 'maple-atlas', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => {
        database.close();
        status('Reload to continue saving progress.');
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => status('Close other Maple Atlas tabs to open progress.');
  });
  const transaction = (mode, operation) => open.then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = operation(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || new Error('Local save was interrupted.'));
    tx.onerror = () => reject(tx.error);
  }));
  window.openai = {
    widgetState: null,
    setWidgetState(next) {
      const snapshot = structuredClone(next);
      this.widgetState = snapshot;
      status('Saving on this device…');
      writeQueue = writeQueue.catch(() => {}).then(() => transaction('readwrite', db => db.put(snapshot, record)));
      return writeQueue.then(() => status('Saved on this device')).catch(error => {
        status('Not saved · Browser storage unavailable');
        throw error;
      });
    }
  };
  window.mapleStorageReady = transaction('readonly', db => db.get(record)).then(async saved => {
    if (!saved && !development) {
      try { saved = JSON.parse(localStorage.getItem(oldKey) || 'null'); } catch (_) {}
      if (saved?.modelContent?.preview === 'maple-atlas-data-v2') {
        await transaction('readwrite', db => db.put(saved, record));
        try { localStorage.removeItem(oldKey); } catch (_) {}
      }
    }
    window.openai.widgetState = saved || null;
    status('Progress saved on this device');
  }).catch(() => {
    status('Browser storage unavailable · Progress will not persist');
  }).finally(() => { app.inert = false; });
})();
