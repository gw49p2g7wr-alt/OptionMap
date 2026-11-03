"use strict";

const Canonical = require("./economicValueCanonical.js");
const Schema = require("./economicValueSchemaV1.js");
const Cpi = require("./blsCpiFormal.js");
const Employment = require("./blsEmploymentFormal.js");
const Sources = require("./economicValueSourceRegistry.js");

const FIELD_STORE = Object.freeze({ runs: "economicSourceRuns", releases: "economicReleaseOccurrences",
  definitions: "economicSeriesDefinitions", entries: "economicValueEntries",
  revisions: "economicValueRevisions", links: "economicReleaseValueLinks",
  documents: "economicSourceDocuments", evidence: "economicAcquisitionEvidence",
  cursors: "economicSourceCursors" });
const KEY = Object.freeze(Object.fromEntries(Object.entries(FIELD_STORE).map(([field, store]) =>
  [field, Schema.STORES[store].keyPath])));
const emptySnapshot = () => Object.fromEntries(Object.keys(FIELD_STORE).map(field => [field, []]));
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("economic_value_request_failed"));
});
const transactionDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error || new Error("economic_value_transaction_aborted"));
  tx.onerror = () => undefined;
});
const same = (left, right) => Canonical.stable(left) === Canonical.stable(right);
const sorted = snapshot => Object.fromEntries(Object.entries(snapshot).map(([field, values]) => [field,
  [...values].sort((left, right) => String(left[KEY[field]]).localeCompare(String(right[KEY[field]])))]));
function error(reason) { throw new Error(reason); }

async function audit(snapshot) {
  const errors = [], unique = (field, key) => {
    const keys = snapshot[field].map(value => value[key]);
    if (keys.some(value => typeof value !== "string" || !value) || new Set(keys).size !== keys.length)
      errors.push(`${field}_identity_invalid`);
  };
  for (const [field, key] of Object.entries(KEY)) unique(field, key);
  if (snapshot.definitions.some(value => !Sources.validateDefinition(value))) errors.push("series_definition_invalid");
  const definitions = new Map(snapshot.definitions.map(value => [value.seriesDefinitionKey, value])),
    releases = new Map(snapshot.releases.map(value => [value.releaseOccurrenceKey, value])),
    revisions = new Map(snapshot.revisions.map(value => [value.revisionKey, value])),
    entries = new Map(snapshot.entries.map(value => [value.valueKey, value])),
    documents = new Map(snapshot.documents.map(value => [value.sourceDocumentKey, value])),
    runs = new Map(snapshot.runs.map(value => [value.runKey, value]));
  for (const revision of snapshot.revisions) {
    const fact = { valueKey: revision.valueKey, seriesDefinitionKey: revision.seriesDefinitionKey,
      referencePeriod: revision.referencePeriod, decimalValue: revision.decimalValue, unit: revision.unit,
      seasonalAdjustment: revision.seasonalAdjustment, measure: revision.measure,
      officialStatus: revision.officialStatus };
    const hash = Canonical.sha256(fact);
    const definition = definitions.get(revision.seriesDefinitionKey);
    if (!definition || !Sources.validateValue({ seriesDefinitionKey: revision.seriesDefinitionKey,
        referencePeriod: revision.referencePeriod, decimalValue: revision.decimalValue, unit: revision.unit,
        seasonalAdjustment: revision.seasonalAdjustment, measure: revision.measure }, [...definitions.values()]) ||
        !Canonical.hash(revision.factHash) ||
        revision.factHash !== hash || revision.revisionKey !== `${revision.valueKey}|sha256:${hash}` ||
        !Canonical.timestamp(revision.validFrom) || revision.validTo !== null && !Canonical.timestamp(revision.validTo) ||
        revision.validTo !== null && revision.validFrom >= revision.validTo ||
        !releases.has(revision.releaseOccurrenceKey)) errors.push("value_revision_invalid");
  }
  for (const entry of snapshot.entries) {
    const own = snapshot.revisions.filter(value => value.valueKey === entry.valueKey)
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom)), active = own.filter(value => value.validTo === null);
    if (active.length !== 1 || active[0].revisionKey !== entry.activeRevisionKey ||
        own.some((value, index) => index > 0 && own[index - 1].validTo !== value.validFrom))
      errors.push("value_revision_interval_invalid");
  }
  for (const link of snapshot.links) if (!releases.has(link.releaseOccurrenceKey) ||
      !revisions.has(link.revisionKey) || link.linkKey !== `${link.releaseOccurrenceKey}|${link.revisionKey}`)
    errors.push("release_value_link_invalid");
  for (const evidence of snapshot.evidence) {
    const material = { sourceId: evidence.sourceId, runId: evidence.runId,
      releaseOccurrenceKey: evidence.releaseOccurrenceKey, sourceDocumentKey: evidence.sourceDocumentKey,
      fetchedAt: evidence.fetchedAt, acceptedAt: evidence.acceptedAt,
      sourcePublishedAt: evidence.sourcePublishedAt, sourceUrl: evidence.sourceUrl,
      parserId: evidence.parserId, parserVersion: evidence.parserVersion,
      rawContentHash: evidence.rawContentHash, httpMetadata: evidence.httpMetadata };
    if (!revisions.has(evidence.revisionKey) || !documents.has(evidence.sourceDocumentKey) ||
        !releases.has(evidence.releaseOccurrenceKey) ||
        !runs.has(`${evidence.sourceId}|${evidence.runId}`) ||
        evidence.acquisitionEvidenceHash !== Canonical.sha256(material) ||
        evidence.evidenceKey !== `${evidence.revisionKey}|${evidence.sourceDocumentKey}|${evidence.runId}`)
      errors.push("acquisition_evidence_invalid");
  }
  for (const cursor of snapshot.cursors) if (!runs.has(cursor.runKey) || !Canonical.timestamp(cursor.acceptedAt))
    errors.push("source_cursor_invalid");
  for (const release of snapshot.releases) if (!documents.has(release.sourceDocumentKey) ||
      !Sources.CONTRACTS.some(contract => contract.AUTHORITY === release.authority &&
        contract.PROGRAM === release.releaseProgram) ||
      !Canonical.timestamp(release.publishedAt) || !Canonical.timestamp(release.fetchedAt) ||
      !Canonical.timestamp(release.acceptedAt)) errors.push("release_occurrence_invalid");
  return Canonical.freeze({ valid: errors.length === 0, errors: [...new Set(errors)] });
}

function validateCandidate(candidate) {
  const contract = Sources.get(candidate?.sourceId);
  if (!contract || !Canonical.timestamp(candidate.acceptedAt) ||
      !Canonical.hash(candidate.candidateHash) || !Canonical.hash(candidate.acquisitionEvidenceHash) ||
      !Array.isArray(candidate.definitions) || candidate.definitions.length !== contract.SERIES.length ||
      candidate.definitions.some(value => !contract.validateDefinition(value)) || !Array.isArray(candidate.values) ||
      candidate.values.length < contract.SERIES.length || candidate.values.some(value => {
        const fact = { valueKey: value.valueKey, seriesDefinitionKey: value.seriesDefinitionKey,
          referencePeriod: value.referencePeriod, decimalValue: value.decimalValue, unit: value.unit,
          seasonalAdjustment: value.seasonalAdjustment, measure: value.measure,
          officialStatus: value.officialStatus }, factHash = Canonical.sha256(fact);
        return !contract.validateValue({ seriesDefinitionKey: value.seriesDefinitionKey,
          referencePeriod: value.referencePeriod, decimalValue: value.decimalValue, unit: value.unit,
          seasonalAdjustment: value.seasonalAdjustment, measure: value.measure }, candidate.definitions) ||
          value.valueKey !== `${value.seriesDefinitionKey}|${value.referencePeriod}` ||
          value.officialStatus !== "published" || value.factHash !== factHash ||
          value.revisionKey !== `${value.valueKey}|sha256:${factHash}`;
      }) ||
      !candidate.release || !candidate.document || candidate.release.sourceDocumentKey !== candidate.document.sourceDocumentKey ||
      candidate.release.releaseOccurrenceKey !== candidate.document.releaseOccurrenceKey ||
      candidate.values.some(value => value.releaseOccurrenceKey !== candidate.release.releaseOccurrenceKey)) return false;
  const current = candidate.values.filter(value => value.referencePeriod === candidate.release.referencePeriod);
  const expectedRunId = Canonical.sha256({ sourceId: candidate.sourceId,
      fetchedAt: candidate.release.fetchedAt, sourceDocumentKey: candidate.document.sourceDocumentKey,
      parserId: candidate.document.parserId, parserVersion: candidate.document.parserVersion }),
    expectedEvidenceHash = Canonical.sha256(candidate.evidenceMaterial);
  if (current.length !== contract.SERIES.length ||
      new Set(current.map(value => value.seriesDefinitionKey)).size !== contract.SERIES.length ||
      contract.SERIES.some(definition => !current.some(value =>
        value.seriesDefinitionKey === definition.seriesDefinitionKey)) ||
      new Set(candidate.values.map(value => value.valueKey)).size !== candidate.values.length ||
      candidate.release.authority !== contract.AUTHORITY || candidate.release.releaseProgram !== contract.PROGRAM ||
      !contract.validateReleaseOccurrenceKey(candidate.release.releaseOccurrenceKey,
        candidate.release.officialReleaseDate, candidate.document.rawContentHash) ||
      !Canonical.date(candidate.release.officialReleaseDate) || !Canonical.month(candidate.release.referencePeriod) ||
      !Canonical.timestamp(candidate.release.publishedAt) || !Canonical.timestamp(candidate.release.fetchedAt) ||
      candidate.release.acceptedAt !== candidate.acceptedAt || candidate.document.sourceId !== candidate.sourceId ||
      candidate.document.role !== "official_release" || candidate.document.sourceUrl !== candidate.release.sourceUrl ||
      candidate.document.parserId !== contract.PARSER_ID || candidate.document.parserVersion !== contract.PARSER_VERSION ||
      !Canonical.hash(candidate.document.rawContentHash) || candidate.runId !== expectedRunId ||
      candidate.runKey !== `${candidate.sourceId}|${expectedRunId}` ||
      candidate.acquisitionEvidenceHash !== expectedEvidenceHash ||
      candidate.evidenceMaterial.sourceId !== candidate.sourceId ||
      candidate.evidenceMaterial.runId !== candidate.runId ||
      candidate.evidenceMaterial.releaseOccurrenceKey !== candidate.release.releaseOccurrenceKey ||
      candidate.evidenceMaterial.sourceDocumentKey !== candidate.document.sourceDocumentKey ||
      candidate.evidenceMaterial.acceptedAt !== candidate.acceptedAt ||
      candidate.evidenceMaterial.fetchedAt !== candidate.release.fetchedAt ||
      candidate.evidenceMaterial.rawContentHash !== candidate.document.rawContentHash) return false;
  const expected = Canonical.sha256({ release: candidate.release,
    values: candidate.values.map(value => value.revisionKey).sort(),
    sourceDocumentKey: candidate.document.sourceDocumentKey,
    acquisitionEvidenceHash: candidate.acquisitionEvidenceHash });
  return expected === candidate.candidateHash;
}

function plan(candidate, snapshot) {
  if (!validateCandidate(candidate)) error("economic_candidate_invalid");
  const priorRun = snapshot.runs.find(value => value.runKey === candidate.runKey);
  if (priorRun) {
    if (priorRun.candidateHash !== candidate.candidateHash) error("economic_run_identity_conflict");
    return { unchanged: true, operations: null };
  }
  const cursor = snapshot.cursors.find(value => value.sourceId === candidate.sourceId);
  if (cursor && cursor.acceptedAt >= candidate.acceptedAt) error("economic_accepted_at_not_monotonic");
  const operations = Object.fromEntries(Object.keys(FIELD_STORE).map(field => [field, { add: [], put: [] }]));
  for (const definition of candidate.definitions) {
    const prior = snapshot.definitions.find(value => value.seriesDefinitionKey === definition.seriesDefinitionKey);
    if (prior && !same(prior, definition)) error("economic_series_definition_conflict");
    if (!prior) operations.definitions.add.push(Canonical.clone(definition));
  }
  const priorRelease = snapshot.releases.find(value => value.releaseOccurrenceKey ===
    candidate.release.releaseOccurrenceKey);
  if (priorRelease && !same(priorRelease, candidate.release)) error("economic_release_identity_conflict");
  if (!priorRelease) operations.releases.add.push(Canonical.clone(candidate.release));
  const priorDocument = snapshot.documents.find(value => value.sourceDocumentKey === candidate.document.sourceDocumentKey);
  if (priorDocument && !same(priorDocument, candidate.document)) error("economic_document_identity_conflict");
  if (!priorDocument) operations.documents.add.push(Canonical.clone(candidate.document));
  const revisionMap = new Map(snapshot.revisions.map(value => [value.revisionKey, value]));
  for (const value of candidate.values) {
    const entry = snapshot.entries.find(item => item.valueKey === value.valueKey),
      active = entry ? revisionMap.get(entry.activeRevisionKey) : null,
      unchanged = active?.revisionKey === value.revisionKey;
    if (entry && !active) error("economic_active_revision_missing");
    if (!revisionMap.has(value.revisionKey)) {
      if (active && !unchanged) operations.revisions.put.push({ ...Canonical.clone(active),
        validTo: candidate.acceptedAt });
      operations.revisions.add.push({ ...Canonical.clone(value), validFrom: candidate.acceptedAt,
        validTo: null, revisionOrigin: active ? "authority_semantic_change" : "initial_observation" });
    }
    if (!entry) operations.entries.add.push({ valueKey: value.valueKey,
      seriesDefinitionKey: value.seriesDefinitionKey, referencePeriod: value.referencePeriod,
      activeRevisionKey: value.revisionKey, firstKnownAt: candidate.acceptedAt,
      lastObservedAt: candidate.acceptedAt });
    else if (!unchanged) operations.entries.put.push({ ...Canonical.clone(entry),
      activeRevisionKey: value.revisionKey, lastObservedAt: candidate.acceptedAt });
    const link = { linkKey: `${candidate.release.releaseOccurrenceKey}|${value.revisionKey}`,
      releaseOccurrenceKey: candidate.release.releaseOccurrenceKey, revisionKey: value.revisionKey,
      valueKey: value.valueKey, role: value.referencePeriod === candidate.release.referencePeriod ?
        "released_current_period" : "released_prior_period_revision" };
    const priorLink = snapshot.links.find(item => item.linkKey === link.linkKey);
    if (priorLink && !same(priorLink, link)) error("economic_release_link_conflict");
    if (!priorLink) operations.links.add.push(link);
    const evidence = { evidenceKey: `${value.revisionKey}|${candidate.document.sourceDocumentKey}|${candidate.runId}`,
      revisionKey: value.revisionKey, ...Canonical.clone(candidate.evidenceMaterial),
      acquisitionEvidenceHash: candidate.acquisitionEvidenceHash };
    const priorEvidence = snapshot.evidence.find(item => item.evidenceKey === evidence.evidenceKey);
    if (priorEvidence && !same(priorEvidence, evidence)) error("economic_evidence_identity_conflict");
    if (!priorEvidence) operations.evidence.add.push(evidence);
  }
  operations.runs.add.push({ runKey: candidate.runKey, sourceId: candidate.sourceId,
    runId: candidate.runId, releaseOccurrenceKey: candidate.release.releaseOccurrenceKey,
    acceptedAt: candidate.acceptedAt, fetchedAt: candidate.release.fetchedAt,
    candidateHash: candidate.candidateHash, status: "accepted" });
  operations.cursors.put.push({ sourceId: candidate.sourceId, acceptedAt: candidate.acceptedAt,
    runKey: candidate.runKey });
  return { unchanged: false, operations };
}

function apply(snapshot, operations) {
  const next = Canonical.clone(snapshot);
  for (const [field, modes] of Object.entries(operations)) {
    const map = new Map(next[field].map(value => [value[KEY[field]], value]));
    for (const value of modes.add) {
      if (map.has(value[KEY[field]])) error("economic_add_conflict");
      map.set(value[KEY[field]], Canonical.clone(value));
    }
    for (const value of modes.put) map.set(value[KEY[field]], Canonical.clone(value));
    next[field] = [...map.values()];
  }
  return sorted(next);
}

async function catalogHas(indexedDB) {
  if (!indexedDB || typeof indexedDB.databases !== "function") error("economic_indexeddb_invalid");
  const catalog = await indexedDB.databases();
  return catalog.some(value => value.name === Schema.DATABASE_NAME);
}
async function openExisting(indexedDB) {
  if (!await catalogHas(indexedDB)) return null;
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME); let upgraded = false;
    opening.onupgradeneeded = () => { upgraded = true; try { opening.transaction.abort(); } catch (_) {} };
    opening.onerror = () => reject(opening.error || new Error("economic_db_open_failed"));
    opening.onsuccess = () => { if (upgraded) { opening.result.close(); reject(new Error("economic_schema_upgrade_forbidden")); }
      else resolve(opening.result); };
  });
}
async function readSnapshot(indexedDB) {
  const db = await openExisting(indexedDB);
  if (!db) return { status: "absent", snapshot: emptySnapshot() };
  let tx;
  try {
    tx = db.transaction(Schema.STORE_NAMES, "readonly");
    if (!Schema.matches(db, tx)) error("economic_schema_mismatch");
    const pairs = await Promise.all(Object.entries(FIELD_STORE).map(async ([field, store]) =>
      [field, await request(tx.objectStore(store).getAll())]));
    await transactionDone(tx);
    const snapshot = sorted(Object.fromEntries(pairs)), checked = await audit(snapshot);
    if (!checked.valid) error(`economic_integrity_invalid:${checked.errors.join(",")}`);
    return { status: "available", snapshot };
  } finally { db.close(); }
}
function queue(tx, operations) {
  for (const [field, modes] of Object.entries(operations)) {
    const store = tx.objectStore(FIELD_STORE[field]);
    for (const value of modes.add) store.add(Canonical.clone(value));
    for (const value of modes.put) store.put(Canonical.clone(value));
  }
}
async function commitFirst(indexedDB, operations, faultAt) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME, Schema.VERSION); let upgrade;
    opening.onupgradeneeded = () => {
      try { Schema.createInUpgrade(opening.result); upgrade = opening.transaction;
        if (faultAt === "first_write_abort") throw new Error("injected_first_write_abort");
        queue(upgrade, operations); }
      catch (cause) { try { opening.transaction.abort(); } catch (_) {} reject(cause); }
    };
    opening.onerror = () => reject(opening.error || new Error("economic_first_write_failed"));
    opening.onsuccess = () => { opening.result.close(); resolve(); };
  });
}
async function commitExisting(indexedDB, operations, faultAt) {
  const db = await openExisting(indexedDB); if (!db) error("economic_db_disappeared");
  try {
    const tx = db.transaction(Schema.STORE_NAMES, "readwrite");
    if (!Schema.matches(db, tx)) { tx.abort(); error("economic_schema_mismatch"); }
    if (faultAt === "transaction_abort") { tx.abort(); await transactionDone(tx); }
    queue(tx, operations); await transactionDone(tx);
  } finally { db.close(); }
}

function createFormalRuntime({ indexedDB, faultAt = null } = {}) {
  if (![null, "before_open", "first_write_abort", "transaction_abort"].includes(faultAt))
    error("economic_fault_point_invalid");
  if (Schema.fingerprint() !== Schema.EXPECTED_FINGERPRINT) error("economic_schema_fingerprint_invalid");
  const tickets = new WeakMap(); let active = false;
  async function registerAcceptedRelease(candidate) {
    if (active) error("economic_writer_single_flight");
    if (!validateCandidate(candidate)) error("economic_candidate_invalid");
    const ticket = Object.freeze({}); tickets.set(ticket, Canonical.clone(candidate)); active = true;
    return ticket;
  }
  async function commitAcceptedRelease(ticket) {
    const candidate = tickets.get(ticket);
    if (!candidate) error("economic_writer_ticket_invalid");
    tickets.delete(ticket);
    try {
      if (faultAt === "before_open") error("injected_before_open");
      const before = await readSnapshot(indexedDB), prepared = plan(candidate, before.snapshot);
      if (prepared.unchanged) return Canonical.freeze({ status: "unchanged", semanticWrites: 0,
        transactionCount: 0, releaseOccurrenceKey: candidate.release.releaseOccurrenceKey });
      const projected = apply(before.snapshot, prepared.operations), checked = await audit(projected);
      if (!checked.valid) error(`economic_next_integrity_invalid:${checked.errors.join(",")}`);
      if (before.status === "absent") await commitFirst(indexedDB, prepared.operations, faultAt);
      else await commitExisting(indexedDB, prepared.operations, faultAt);
      const after = await readSnapshot(indexedDB);
      if (!same(after.snapshot, projected)) error("economic_commit_readback_mismatch");
      return Canonical.freeze({ status: "committed", semanticWrites:
        prepared.operations.revisions.add.length, transactionCount: 1,
        releaseOccurrenceKey: candidate.release.releaseOccurrenceKey });
    } finally { active = false; }
  }
  return Canonical.freeze({ registerAcceptedRelease, commitAcceptedRelease,
    readSnapshot: () => readSnapshot(indexedDB) });
}

function selectAt(snapshot, at) {
  if (!Canonical.timestamp(at)) error("economic_as_known_at_invalid");
  const revisions = snapshot.revisions.filter(value => value.validFrom <= at &&
    (value.validTo === null || at < value.validTo)).sort((a, b) =>
    a.seriesDefinitionKey.localeCompare(b.seriesDefinitionKey) || a.referencePeriod.localeCompare(b.referencePeriod));
  return revisions;
}
async function readCurrentCpi(indexedDB) {
  return readCurrentSource(indexedDB, Cpi.SOURCE_ID);
}
async function readCurrentEmployment(indexedDB) {
  return readCurrentSource(indexedDB, Employment.SOURCE_ID);
}
async function readCurrentSource(indexedDB, sourceId) {
  const contract = Sources.get(sourceId);
  if (!contract) error("economic_source_unknown");
  const result = await readSnapshot(indexedDB);
  if (result.status === "absent") return Canonical.freeze({ status: "unavailable", reason: "database_absent" });
  const snapshot = result.snapshot, release = snapshot.releases.filter(value =>
    value.authority === contract.AUTHORITY && value.releaseProgram === contract.PROGRAM).sort((a, b) =>
    a.acceptedAt.localeCompare(b.acceptedAt)).at(-1);
  if (!release) return Canonical.freeze({ status: "unavailable", reason: "release_absent" });
  const seriesKeys = new Set(contract.SERIES.map(value => value.seriesDefinitionKey)),
    values = snapshot.entries.filter(entry => seriesKeys.has(entry.seriesDefinitionKey)).map(entry => snapshot.revisions.find(value =>
    value.revisionKey === entry.activeRevisionKey)).filter(Boolean).sort((a, b) =>
    a.seriesDefinitionKey.localeCompare(b.seriesDefinitionKey) || a.referencePeriod.localeCompare(b.referencePeriod)),
    revisionKeys = new Set(values.map(value => value.revisionKey));
  return Canonical.freeze({ status: "available", readiness: "formal_reference", releaseOccurrence: release,
    seriesDefinitions: snapshot.definitions.filter(value => seriesKeys.has(value.seriesDefinitionKey)),
    officialValues: values, provenance: snapshot.evidence.filter(value => value.sourceId === sourceId &&
      revisionKeys.has(value.revisionKey)) });
}
async function readAsKnownAt(indexedDB, at) {
  const result = await readSnapshot(indexedDB);
  if (result.status === "absent") return Canonical.freeze({ status: "unavailable", reason: "database_absent" });
  return Canonical.freeze({ status: "available", readiness: "formal_reference", asKnownAt: at,
    seriesDefinitions: result.snapshot.definitions, officialValues: selectAt(result.snapshot, at),
    releaseOccurrences: result.snapshot.releases.filter(value => value.acceptedAt <= at) });
}

module.exports = Canonical.freeze({ FIELD_STORE, KEY, emptySnapshot, audit, validateCandidate, plan, apply,
  readSnapshot, createFormalRuntime, selectAt, readCurrentSource, readCurrentCpi, readCurrentEmployment,
  readAsKnownAt });
