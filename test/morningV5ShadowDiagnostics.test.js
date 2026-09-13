"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Diagnostics = require("../js/morningV5ShadowDiagnostics.js");
test("diagnostics expose authority mapping guards and isolation", () => {
    const value = Diagnostics.createDiagnostics({ referenceState: { fact: { referenceOnly: true,
        overallEligible: false, optionContract: "2026-10", contract: "2026-12" }, mapping: {
        mappingClass: "explicit_cross_contract_reference", mappingId: "mapping" } }, collectorState: {
        formalSupplyDemand: { available: true, formalScopeId: "scope", optionContract: "2026-10",
            sourceFingerprint: "formal" }, referencePrice: { available: true }, diagnostics: {
            refreshInProgress: false, generationsMatched: true, generationGuard: { accepted: true } } },
        runtimeState: { status: "available", reason: null } });
    assert.equal(value.mode, "shadow_only"); assert.equal(value.reference.referenceOnly, true);
    assert.equal(value.reference.overallEligible, false); assert.equal(value.guards.generationAccepted, true);
    assert.deepEqual(value.isolation, { storageWritten: false, uiRendered: false,
        fullExportIncluded: false, overallReferencePriceInjected: false });
});
test("missing sources remain observable without fabricating identity", () => {
    const value = Diagnostics.createDiagnostics({}); assert.equal(value.status, "empty");
    assert.equal(value.formal.scopeId, null); assert.equal(value.reference.mappingId, null);
});
