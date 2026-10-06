/**
 * Reads and writes settings as the chunked items `packSettings` lays out.
 *
 * Every function takes the storage area as an argument rather than reaching
 * for `chrome.storage.sync` itself, so the content scripts, popup and service
 * worker share one implementation and the tests can hand it a fake.
 */
(function (root) {
  'use strict';

  const { STORAGE_KEY, CHUNK_PREFIX, packSettings, unpackSettings } = root.GHUN;

  function isStoreKey(key) {
    return key === STORAGE_KEY || key.startsWith(CHUNK_PREFIX);
  }

  async function load(area) {
    return unpackSettings(await area.get(null));
  }

  /**
   * One `set` carries the settings item and every chunk, so a reader sees all of
   * a save or none of it. Chunks left over from a larger save are removed after;
   * until then the chunk count in the settings item already tells readers to
   * skip them.
   */
  async function save(area, settings) {
    const items = packSettings(settings);
    const existing = await area.get(null);
    await area.set(items);

    const stale = Object.keys(existing).filter(
      (key) => key.startsWith(CHUNK_PREFIX) && !(key in items)
    );
    if (stale.length) await area.remove(stale);
  }

  /** Re-read before writing, so a change made elsewhere meanwhile isn't lost. */
  async function update(area, mutate) {
    const settings = await load(area);
    mutate(settings);
    await save(area, settings);
    return settings;
  }

  root.GHUN_STORE = { isStoreKey, load, save, update };
})(typeof globalThis !== 'undefined' ? globalThis : self);
