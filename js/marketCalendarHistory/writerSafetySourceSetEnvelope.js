"use strict";

// Explicit isolated source-set extension. Historical v1/v2 validation is delegated
// unchanged, and the complete historical record (including audit) is retained.
const A = require("./formalWriterAuthorityV2.js");
const Historical = require("./writerSafetyVersionedEnvelope.js");
const File = require("./writerSafetyFileSchema.js");
const P = require("./writerSafetySourceSetPermission.js");
const Controlled = require("./writerSafetyControlledLifecycle.js");
const VERSION = 3, REASON = "explicit_source_set_migration";
const INPUT_KEYS = Object.freeze(["expectedEnvelopeVersion", "expectedSourceSetVersion", "expectedPermissionVersion",
  "expectedSequence", "nextEnvelopeVersion", "nextSourceSetVersion", "nextPermissionVersion", "addedSourceIds",
  "removedSourceIds", "reasonCode", "gateIdentity"]);
const same = (a, b) => A.hash(a) === A.hash(b);
const fail = reason => { throw Error(reason); };
function requestFor(record, gateIdentity) {
  return A.freeze({ expectedEnvelopeVersion: 2, expectedSourceSetVersion: 1, expectedPermissionVersion: 1,
    expectedSequence: record.safety.sequence, nextEnvelopeVersion: VERSION, nextSourceSetVersion: P.SOURCE_SET_VERSION,
    nextPermissionVersion: P.PERMISSION_VERSION, addedSourceIds: [P.MOF], removedSourceIds: [], reasonCode: REASON, gateIdentity });
}
function preconditions(record, input) {
  if (!A.exact(input, INPUT_KEYS) || !A.isHash(input.gateIdentity) || input.reasonCode !== REASON)
    fail("source_set_migration_input_invalid");
  if (record?.schemaVersion !== 2 || !Historical.validateEnvelope(record).valid) fail("historical_envelope_required");
  if (record.safety.pendingFence) fail("source_set_pending_fence");
  if (record.safety.globalSuspend.suspended) fail("source_set_global_suspended");
  if (record.safety.persistedAuthorityVersion !== 3) fail("source_set_authority_invalid");
  if (input.expectedEnvelopeVersion !== 2 || input.expectedSourceSetVersion !== 1 ||
    input.expectedPermissionVersion !== 1 || record.safety.sourcePermissionVersion !== 1 ||
    !A.integer(input.expectedSequence) || input.expectedSequence !== record.safety.sequence)
    fail("source_set_precondition_stale");
  if (input.nextEnvelopeVersion !== VERSION || input.nextSourceSetVersion !== 2 || input.nextPermissionVersion !== 2 ||
    !same(input.addedSourceIds, [P.MOF]) || !same(input.removedSourceIds, [])) fail("source_set_extension_invalid");
  if (!A.integer(record.safety.sequence + 1)) fail("source_set_sequence_invalid");
  if (record.legacyRecord.transitionAudit.length + record.transitionAudit.length >= File.MAX_AUDIT)
    fail("safety_audit_capacity_reached");
}
function build(record, input) {
  preconditions(record, input);
  const { validationIdentity: _, ...previous } = structuredClone(record.safety);
  const current = { ...previous, safetyEnvelopeVersion: VERSION, sourceSetVersion: 2, sourcePermissionVersion: 2,
    sourcePermissionIdentity: P.PERMISSIONS.identity, sequence: previous.sequence + 1,
    sources: [...previous.sources, P.emptySource()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)) };
  const safety = A.freeze({ ...current, validationIdentity: A.hash(current) });
  const migrationIdentity = A.hash({ historicalChecksum: record.checksum, input });
  const audit = { previousEnvelopeVersion: 2, nextEnvelopeVersion: VERSION, previousSourceSetVersion: 1,
    nextSourceSetVersion: 2, previousPermissionVersion: 1, nextPermissionVersion: 2,
    previousSequence: previous.sequence, nextSequence: safety.sequence,
    previousAuthorityIdentity: previous.persistedAuthorityIdentity, nextAuthorityIdentity: safety.persistedAuthorityIdentity,
    sourceSetBefore: P.HISTORICAL_IDS, sourceSetAfter: P.SOURCE_IDS, addedSourceIds: [P.MOF], removedSourceIds: [],
    reasonCode: REASON, gateIdentity: input.gateIdentity, migrationIdentity,
    previousAuditIdentity: record.transitionAudit.at(-1).auditIdentity };
  return File.seal({ schemaVersion: VERSION, safety, historicalRecord: record, migrationIdentity,
    sourceSetAudit: [{ ...audit, auditIdentity: A.hash(audit) }] });
}
function migrateSourceSet(record, input) { return build(record, input); }
function validate(record) {
  try {
    if ([1, 2].includes(record?.schemaVersion)) {
      const result = Historical.validateEnvelope(record);
      return A.freeze({ ...result, kind: "historical", sourceSetVersion: 1, autoUpgrade: false });
    }
    const keys = ["schemaVersion", "safety", "historicalRecord", "migrationIdentity", "sourceSetAudit", "checksum"];
    if (Object.hasOwn(record || {}, "controlledLifecycleAudit")) keys.push("controlledLifecycleAudit");
    if (!A.exact(record, keys) ||
      record.schemaVersion !== VERSION || !same(record, File.seal(record)) ||
      !Array.isArray(record.sourceSetAudit) || record.sourceSetAudit.length !== 1) fail("source_set_envelope_invalid");
    const expected = build(record.historicalRecord, requestFor(record.historicalRecord, record.sourceSetAudit[0].gateIdentity));
    if (Object.hasOwn(record, "controlledLifecycleAudit") ? !Controlled.validate(expected, record) : !same(record, expected))
      fail("source_set_history_or_current_mismatch");
    return A.freeze({ valid: true, reason: null, kind: "source_set_v2", sourceSetVersion: 2,
      autoUpgrade: false, writeAllowed: false, executionAllowed: false });
  } catch (e) { return A.freeze({ valid: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "source_set_envelope_invalid",
    writeAllowed: false, executionAllowed: false }); }
}
module.exports = Object.freeze({ VERSION, REASON, INPUT_KEYS, requestFor, migrateSourceSet, validate });
