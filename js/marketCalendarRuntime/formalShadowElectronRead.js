"use strict";

// Fixed database, no creation/upgrade/recovery, and only readonly transactions.
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const Bootstrap = require("../marketCalendarHistory/bootstrapSchemaV1.js");
async function readInRenderer(Schema, inspect, fingerprint, stores) {
  const audit = { opens: 0, readonly: 0, readwrite: 0, create: 0, upgrade: 0, writes: 0, handles: 0 };
  let db, timer;
  try {
    const catalog = await indexedDB.databases();
    const item = catalog.find(value => value.name === Schema.DATABASE_NAME);
    if (!item) return { status: "unavailable", reason: "formal_database_absent", audit };
    if (item.version !== Schema.DATABASE_VERSION) throw Error("schema_fingerprint_mismatch");
    db = await new Promise((resolve, reject) => {
      let stopped = false;
      const request = indexedDB.open(Schema.DATABASE_NAME);
      audit.opens++;
      const fail = reason => { stopped = true; reject(Error(reason)); };
      timer = setTimeout(() => fail("formal_read_timeout"), 15000);
      request.onupgradeneeded = () => { audit.upgrade++; audit.create++; request.transaction.abort(); fail("upgrade_forbidden"); };
      request.onblocked = () => fail("formal_open_blocked");
      request.onerror = () => fail("formal_open_failed");
      request.onsuccess = () => { if (stopped) request.result.close(); else resolve(request.result); };
    });
    clearTimeout(timer); audit.handles++;
    // Inspect schema and queue all six getAll requests synchronously in one transaction.
    // Digest is intentionally deferred until the readonly transaction has completed.
    const tx = db.transaction(stores.map(s => s[1]), "readonly"); audit.readonly++;
    const schema = inspect(db, tx);
    const snapshot = await new Promise((resolve, reject) => {
      const value = {};
      for (const [field, name] of stores) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { value[field] = request.result; };
        request.onerror = () => reject(Error("formal_read_failed"));
      }
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(Error("formal_read_failed")); tx.onerror = () => undefined;
    });
    const schemaFingerprint = await fingerprint(schema);
    if (schemaFingerprint !== Schema.EXPECTED_FINGERPRINT) throw Error("schema_fingerprint_mismatch");
    return { status: "ok", snapshot, schemaFingerprint, audit };
  } catch (error) { return { status: "unavailable", reason: error.message, audit }; }
  finally { clearTimeout(timer); if (db) { db.close(); audit.handles--; } }
}
function createReader(webContents) {
  // The serialized inspection helper closes over Schema; bind it explicitly in the
  // renderer instead of relying on an app global (the isolated window has none).
  return () => webContents.executeJavaScript(`(() => { const Schema = {
    DATABASE_NAME: ${JSON.stringify(Schema.DATABASE_NAME)}, DATABASE_VERSION: ${Schema.VERSION},
    STORES: ${JSON.stringify(Schema.STORES)}, EXPECTED_FINGERPRINT: ${JSON.stringify(Schema.EXPECTED_FINGERPRINT)} };
    return (${readInRenderer.toString()})(Schema,
    (${Bootstrap.inspect.toString()}), (${Schema.fingerprint.toString()}),
    ${JSON.stringify(Bootstrap.STORE_ORDER)}); })()`, true);
}
module.exports = Object.freeze({ createReader });
