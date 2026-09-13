"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Guard = require("../js/morningV5ShadowGenerationGuard.js");
const identity = () => ({ qri: 2, weekly: 3, overall: 4, reference: 5,
    requestIds: ["r1", "r1", "r1", "r1"] });
test("accepts one stable refresh generation", () => {
    assert.equal(Guard.evaluateMorningV5ShadowGenerationGuard(identity(), identity()).accepted, true);
});
test("rejects source changes during async collection", () => {
    const end = identity(); end.reference = 6;
    assert.equal(Guard.evaluateMorningV5ShadowGenerationGuard(identity(), end).reason,
        "source_generation_changed");
});
test("rejects mixed formal and reference requests", () => {
    const formal = identity(); formal.requestIds[2] = "r2";
    assert.equal(Guard.evaluateMorningV5ShadowGenerationGuard(formal, formal).reason,
        "formal_request_mismatch");
    const reference = identity(); reference.requestIds[3] = "r2";
    assert.equal(Guard.evaluateMorningV5ShadowGenerationGuard(reference, reference).reason,
        "reference_request_mismatch");
});
