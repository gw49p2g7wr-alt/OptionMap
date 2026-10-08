"use strict";

// Serialized into the dedicated private world only. Material is DATA, not an
// execution token. Main confirmation precedes the FIRST and only token mint.
async function runRenderer(material, invitation, Core, execute, Schema, inspect, fingerprint, stable, counts, fixtureFault) {
  const SOURCE = "jp-mof-jgb-auction-calendar", OPERATION = "controlled-first-formal-write";
  const exact = (o, keys) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join("|") === [...keys].sort().join("|");
  const hash = async v => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(v))))]
    .map(n => n.toString(16).padStart(2, "0")).join("");
  if (globalThis.__mofNativeAttempt) throw Error("native_second_invocation_rejected");
  globalThis.__mofNativeAttempt = true;
  if (!exact(material, ["plan", "before", "expected", "attemptIdentity", "semanticPlanIdentity", "acquisitionIdentity", "documentSetIdentity",
    "documentObservationIdentity", "evidenceIdentities", "comparisonIdentity", "formalPrecondition", "planIdentity"]) ||
    material.plan.sourceId !== SOURCE || invitation.binding.sourceId !== SOURCE || invitation.binding.operation !== OPERATION ||
    location.href !== invitation.target.documentUrl || await hash(material) !== invitation.materialIdentity ||
    material.planIdentity !== invitation.binding.planIdentity || await hash(material.plan.counts) !== await hash(counts))
    throw Error("native_material_binding_invalid");
  const bridge = globalThis.__mofPrivateGrant;
  if (!bridge || !exact(bridge, ["challenge", "consume", "submitReceipt"])) throw Error("native_private_bridge_missing");
  const packet = { attemptIdentity: material.attemptIdentity, invitationIdentity: invitation.identity, nonce: invitation.nonce,
    rendererChallenge: crypto.randomUUID(), materialIdentity: invitation.materialIdentity };
  if (fixtureFault === "wrong_challenge") packet.nonce = "wrong";
  const challenge = await bridge.challenge(packet);
  if (fixtureFault === "after_challenge") throw Error("fixture_after_challenge");
  if (fixtureFault === "replay_challenge") {
    await bridge.challenge(packet); throw Error("fixture_challenge_replay_accepted");
  }
  const permit = await bridge.consume({ ...packet, challengeIdentity: challenge.challengeIdentity });
  if (!exact(permit, ["schemaVersion", "attemptIdentity", "consumeIdentity", "startedSequence", "startedGeneration", "startedChecksum"]) ||
    permit.schemaVersion !== 1 || permit.attemptIdentity !== material.attemptIdentity || permit.startedSequence !== invitation.preparedSequence + 1)
    throw Error("native_execution_permit_invalid");
  if (fixtureFault === "after_permit") throw Error("fixture_after_permit");
  if (fixtureFault === "replay_consume") {
    await bridge.consume({ ...packet, challengeIdentity: challenge.challengeIdentity }); throw Error("fixture_consume_replay_accepted");
  }
  let minted = 0, calls = 0, active = false, rw = 0, network = 0, deletes = 0;
  const actualCounts = Object.fromEntries(Object.keys(counts).map(k => [k, 0])), originals = [];
  const replace = (o, key, fn) => { const old = o[key]; originals.push(() => { o[key] = old; }); o[key] = fn(old); };
  const fields = Object.fromEntries(Core.STORE_ORDER.map(([f, n]) => [n, f]));
  const operation = { entries: { add: "eventEntryCreate", put: "eventEntryUpdate" }, revisions: { add: "semanticRevisionCreate", put: "semanticRevisionClose" },
    evidence: { add: "evidenceCreate" }, observations: { add: "observationCreate" }, runs: { add: "sourceRunCreate" }, cursors: { put: "sourceCursorUpdate" } };
  replace(IDBDatabase.prototype, "transaction", raw => function(names, mode, ...args) {
    if (this.name === Schema.DATABASE_NAME && mode === "readwrite") {
      if (!active || rw || JSON.stringify([...names]) !== JSON.stringify(Core.STORE_NAMES)) throw Error("native_second_transaction_rejected");
      rw++; const tx = raw.call(this, names, mode, ...args); if (fixtureFault === "during_tx") tx.abort(); return tx;
    } return raw.call(this, names, mode, ...args);
  });
  for (const kind of ["add", "put"]) replace(IDBObjectStore.prototype, kind, raw => function(value, ...args) {
    if (this.transaction.db.name === Schema.DATABASE_NAME && this.transaction.mode === "readwrite") {
      const field = operation[fields[this.name]]?.[kind];
      if (!active || !field || value.sourceId !== SOURCE || actualCounts[field] >= counts[field]) throw Error("native_mutation_scope_invalid");
      actualCounts[field]++;
    } return raw.call(this, value, ...args);
  });
  for (const kind of ["delete", "clear"]) replace(IDBObjectStore.prototype, kind, raw => function(...args) {
    if (this.transaction.db.name === Schema.DATABASE_NAME) { deletes++; throw Error("native_delete_forbidden"); }
    return raw.call(this, ...args);
  });
  const denyNetwork = () => { network++; throw Error("native_network_forbidden"); };
  replace(globalThis, "fetch", () => denyNetwork); replace(XMLHttpRequest.prototype, "send", () => denyNetwork);
  replace(globalThis, "WebSocket", () => function() { denyNetwork(); });
  replace(navigator, "sendBeacon", () => denyNetwork);
  let observed;
  try {
    active = true;
    const guardedCore = Object.freeze({ ...Core,
      prepareExecution(...args) { if (minted++) throw Error("native_second_token_rejected"); return Core.prepareExecution(...args); },
      executePrepared(...args) { if (calls++) throw Error("native_second_writer_rejected");
        if (fixtureFault === "after_token") throw Error("fixture_after_token"); return Core.executePrepared(...args); }
    });
    observed = await execute({ binding: { databaseName: Schema.DATABASE_NAME, sourceId: SOURCE, invocationId: material.attemptIdentity,
      authorityMode: "G1_5b4_mof_controlled_first_write", plannedReadwriteTransactions: 1,
      identities: { schemaFingerprint: Schema.EXPECTED_FINGERPRINT, plan: material.planIdentity },
      exactMutationCeiling: Object.fromEntries(Object.keys(material.plan.mutations).map(k => [k, material.plan.mutations[k].length])) },
      before: material.before, plan: material.plan, expectedAfter: material.expected, expiresAt: Date.now() + 300000 }, guardedCore, Schema,
      inspect, fingerprint, SOURCE, "G1_5b4_mof_controlled_first_write", counts);
    if (fixtureFault === "second_tx") {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(Schema.DATABASE_NAME, 1);
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { db.transaction(Core.STORE_NAMES, "readwrite"); throw Error("fixture_second_transaction_accepted"); }
      finally { db.close(); }
    }
    if (fixtureFault === "commit_ambiguous") throw Error("fixture_commit_ambiguous");
  } finally { active = false; originals.reverse().forEach(fn => fn()); }
  const beforeIdentity = await hash(Core.sorted(material.before)), afterIdentity = observed.readback ? await hash(Core.sorted(observed.readback)) : null;
  const receipt = { schemaVersion: 1, sourceId: SOURCE, operation: OPERATION, attemptIdentity: material.attemptIdentity,
    consumeIdentity: permit.consumeIdentity, status: observed.status, reason: observed.reason,
    localToken: { minted, writerCalls: calls, success: observed.committed === true },
    transactions: { readwrite: observed.metrics.readwriteTransactions, commit: observed.metrics.committedTransactions, abort: observed.metrics.abortedTransactions },
    counts: actualCounts, preIdentity: beforeIdentity, postIdentity: afterIdentity, readbackIdentity: afterIdentity,
    integrity: observed.status === "verified" && afterIdentity === invitation.binding.expectedFormalIdentity,
    snapshot: observed.readback, audit: { create: observed.audit.create, upgrade: observed.audit.upgrade, deletes, network,
      handles: observed.audit.openHandles, readbackReopens: observed.audit.readbackReopens } };
  const submitted = await bridge.submitReceipt(receipt);
  if (!submitted.accepted) throw Error(submitted.reason); return { status: "submitted", consumeIdentity: permit.consumeIdentity };
}
module.exports = Object.freeze({ runRenderer });
