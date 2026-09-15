// c:\Users\MY PC\OneDrive\Desktop\abc\sniper v2\public\js\cacheDB.js

window.cacheDB = (function() {
  const DB_NAME = 'AeroSniperCache';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = (event) => {
        console.error('[CacheDB] Error opening DB', event);
        reject(event.target.error);
      };
      request.onsuccess = (event) => {
        resolve(event.target.result);
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('collections')) {
          db.createObjectStore('collections', { keyPath: 'slug' });
        }
        if (!db.objectStoreNames.contains('tokenRanks')) {
          const store = db.createObjectStore('tokenRanks', { keyPath: 'key' });
          store.createIndex('slug', 'slug', { unique: false });
        }
        if (!db.objectStoreNames.contains('traitIndex')) {
          db.createObjectStore('traitIndex', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('icWeights')) {
          db.createObjectStore('icWeights', { keyPath: 'slug' });
        }
      };
    });
    return dbPromise;
  }

  // helper to get a single store and perform an action
  async function withStore(storeName, mode, callback) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result = undefined;
      let callbackResult;
      
      try {
        callbackResult = callback(store);
      } catch (e) {
        return reject(e);
      }
      
      if (callbackResult && typeof callbackResult.onsuccess !== 'undefined') {
        callbackResult.onsuccess = (e) => resolve(e.target.result);
        callbackResult.onerror = (e) => reject(e.target.error);
      } else {
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = (e) => reject(e.target.error);
        if (callbackResult instanceof Promise) {
          callbackResult.then(res => { result = res; }).catch(reject);
        }
      }
    });
  }

  return {
    openDB,

    async saveCollection(slug, data) {
      try {
        await withStore('collections', 'readwrite', store => {
          return store.put({ ...data, slug, scannedAt: Date.now() });
        });
        console.log(`[CacheDB] Saved collection ${slug}`);
      } catch (e) {
        console.error('[CacheDB] Error saving collection', e);
      }
    },

    async getCollection(slug) {
      try {
        return await withStore('collections', 'readonly', store => store.get(slug));
      } catch (e) {
        console.error('[CacheDB] Error getting collection', e);
        return null;
      }
    },

    async getCachedSlugs() {
      try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
          const transaction = db.transaction('collections', 'readonly');
          const store = transaction.objectStore('collections');
          const request = store.getAllKeys();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });
      } catch (e) {
        console.error('[CacheDB] Error getting cached slugs', e);
        return [];
      }
    },

    async saveTokenBatch(slug, tokensObj) {
      try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
          const transaction = db.transaction('tokenRanks', 'readwrite');
          const store = transaction.objectStore('tokenRanks');
          for (const [tokenId, data] of Object.entries(tokensObj)) {
            store.put({
              key: `${slug}:${tokenId}`,
              slug,
              tokenId,
              ...data
            });
          }
          transaction.oncomplete = () => {
            console.log(`[CacheDB] Saved ${Object.keys(tokensObj).length} tokens for ${slug}`);
            resolve();
          };
          transaction.onerror = (e) => reject(e.target.error);
        });
      } catch (e) {
        console.error('[CacheDB] Error saving token batch', e);
      }
    },

    async getTokenRank(slug, tokenId) {
      try {
        const info = await this.getTokenInfo(slug, tokenId);
        return info ? info.rank : null;
      } catch (e) {
        console.error('[CacheDB] Error getting token rank', e);
        return null;
      }
    },

    async getTokenInfo(slug, tokenId) {
      try {
        return await withStore('tokenRanks', 'readonly', store => store.get(`${slug}:${tokenId}`));
      } catch (e) {
        console.error('[CacheDB] Error getting token info', e);
        return null;
      }
    },

    async getAllTokenRanks(slug) {
      try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
          const transaction = db.transaction('tokenRanks', 'readonly');
          const store = transaction.objectStore('tokenRanks');
          const index = store.index('slug');
          const request = index.getAll(slug);
          request.onsuccess = () => {
            const map = new Map();
            if (request.result) {
              for (const item of request.result) {
                map.set(item.tokenId, item.rank);
              }
            }
            resolve(map);
          };
          request.onerror = () => reject(request.error);
        });
      } catch (e) {
        console.error('[CacheDB] Error getting all token ranks', e);
        return new Map();
      }
    },

    async saveTraitIndex(slug, traitIndexObj) {
      try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
          const transaction = db.transaction('traitIndex', 'readwrite');
          const store = transaction.objectStore('traitIndex');
          for (const [typeValue, tokenIds] of Object.entries(traitIndexObj)) {
            store.put({
              key: `${slug}:${typeValue}`,
              slug,
              tokenIds
            });
          }
          transaction.oncomplete = () => {
            console.log(`[CacheDB] Saved trait index for ${slug}`);
            resolve();
          };
          transaction.onerror = (e) => reject(e.target.error);
        });
      } catch (e) {
        console.error('[CacheDB] Error saving trait index', e);
      }
    },

    async hasTraitLocal(slug, tokenId, traitType, traitValue) {
      try {
        const entry = await withStore('traitIndex', 'readonly', store => store.get(`${slug}:${traitType}:${traitValue}`));
        if (entry && entry.tokenIds) {
          return entry.tokenIds.includes(tokenId) || entry.tokenIds.includes(String(tokenId)) || entry.tokenIds.includes(Number(tokenId));
        }
        return false;
      } catch (e) {
        console.error('[CacheDB] Error checking trait local', e);
        return false;
      }
    },

    async saveICWeights(slug, weightsData) {
      try {
        await withStore('icWeights', 'readwrite', store => {
          return store.put({ ...weightsData, slug, savedAt: Date.now() });
        });
        console.log(`[CacheDB] Saved IC weights for ${slug}`);
      } catch (e) {
        console.error('[CacheDB] Error saving IC weights', e);
      }
    },

    async getICWeights(slug) {
      try {
        return await withStore('icWeights', 'readonly', store => store.get(slug));
      } catch (e) {
        console.error('[CacheDB] Error getting IC weights', e);
        return null;
      }
    },

    async clearCollection(slug) {
      try {
        const db = await openDB();
        const transaction = db.transaction(['collections', 'tokenRanks', 'traitIndex', 'icWeights'], 'readwrite');
        
        transaction.objectStore('collections').delete(slug);
        transaction.objectStore('icWeights').delete(slug);
        
        const tokenStore = transaction.objectStore('tokenRanks');
        const tokenIndex = tokenStore.index('slug');
        tokenIndex.openCursor(IDBKeyRange.only(slug)).onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        
        // traitIndex doesn't have an index on slug, we'll iterate
        const traitStore = transaction.objectStore('traitIndex');
        traitStore.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (cursor.value.slug === slug) {
              cursor.delete();
            }
            cursor.continue();
          }
        };

        return new Promise((resolve, reject) => {
          transaction.oncomplete = () => {
            console.log(`[CacheDB] Cleared collection ${slug}`);
            resolve();
          };
          transaction.onerror = (e) => reject(e.target.error);
        });
      } catch (e) {
        console.error('[CacheDB] Error clearing collection', e);
      }
    },

    async pruneOldCollections(maxAgeDays = 7, maxCount = 10) {
      try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
          const transaction = db.transaction('collections', 'readonly');
          const store = transaction.objectStore('collections');
          const request = store.getAll();
          
          request.onsuccess = async () => {
            const collections = request.result || [];
            const now = Date.now();
            const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
            
            // Sort by scannedAt (newest first)
            collections.sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0));
            
            const toRemove = [];
            for (let i = 0; i < collections.length; i++) {
              const col = collections[i];
              if (i >= maxCount || (now - (col.scannedAt || 0)) > maxAgeMs) {
                toRemove.push(col.slug);
              }
            }
            
            for (const slug of toRemove) {
              await this.clearCollection(slug);
            }
            
            console.log(`[CacheDB] Pruned ${toRemove.length} old collections`);
            resolve();
          };
          request.onerror = (e) => reject(request.error);
        });
      } catch (e) {
        console.error('[CacheDB] Error pruning old collections', e);
      }
    }
  };
})();
