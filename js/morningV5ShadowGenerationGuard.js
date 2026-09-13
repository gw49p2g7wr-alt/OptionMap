(function (root, factory) { const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningV5ShadowGenerationGuard = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict"; const GUARD_VERSION = 1;
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const scalar = value => value === null || typeof value === "string" || Number.isSafeInteger(value);
    function evaluateMorningV5ShadowGenerationGuard(start, end) {
        if (!start || !end || ![start.qri, start.weekly, start.overall, start.reference,
            end.qri, end.weekly, end.overall, end.reference].every(scalar))
            return freeze({ guardVersion: GUARD_VERSION, accepted: false, reason: "generation_invalid" });
        const generationMatched = ["qri", "weekly", "overall", "reference"]
            .every(key => start[key] === end[key]);
        const startRequests = start.requestIds || [], endRequests = end.requestIds || [];
        const requestSnapshotMatched = JSON.stringify(startRequests) === JSON.stringify(endRequests);
        const formalRequests = [startRequests[0], startRequests[2]].filter(Boolean);
        const formalRequestMatched = formalRequests.length > 0 && new Set(formalRequests).size === 1;
        const referenceRequestMatched = !startRequests[3] || startRequests[3] === startRequests[0];
        const accepted = generationMatched && requestSnapshotMatched && formalRequestMatched &&
            referenceRequestMatched;
        return freeze({ guardVersion: GUARD_VERSION, accepted, reason: accepted ? null :
            !generationMatched ? "source_generation_changed" : !requestSnapshotMatched ?
                "request_snapshot_changed" : !formalRequestMatched ? "formal_request_mismatch" :
                    "reference_request_mismatch", generationMatched, requestSnapshotMatched,
            formalRequestMatched, referenceRequestMatched });
    }
    return freeze({ GUARD_VERSION, evaluateMorningV5ShadowGenerationGuard });
});
