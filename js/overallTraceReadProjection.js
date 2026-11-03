(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapOverallTraceReadProjection = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    const freeze = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); };
    const component = (current, delta, name) => ({ name,
        readiness: current?.readiness || "unavailable",
        effectiveWeight: current?.effectiveWeight ?? null,
        weightedContribution: current?.weightedContribution ?? null,
        readinessChanged: delta?.readinessChanged ?? false,
        inputIdentityChanged: delta?.inputIdentityChanged ?? false,
        currentQriRevisionChanged: delta?.currentQriRevisionChanged ?? null,
        previousComparisonRevisionChanged: delta?.previousComparisonRevisionChanged ?? null,
        futuresQuoteChanged: delta?.futuresQuoteChanged ?? null,
        currentRevisionChanged: delta?.currentRevisionChanged ?? null,
        previousRevisionChanged: delta?.previousRevisionChanged ?? null,
        scoringVersionChanged: delta?.scoringVersionChanged ?? null,
        effectiveWeightDelta: delta?.effectiveWeight?.delta ?? null,
        weightedContributionDelta: delta?.weightedContribution?.delta ?? null });
    function hint(change) {
        if (!change) return "比較できる保存traceはありません。";
        if (change.classification === "first_observation") return "初回観測のため前回比較はありません。";
        if (change.comparability !== "comparable") return "前回traceとは比較できません。";
        const logic = change.logicIdentityChanges?.changed === true;
        const input = change.inputIdentityChanges?.changed === true;
        const readiness = ["overall", "option", "weekly"].some(name =>
            change.readinessChanges?.[name]?.changed === true);
        if (logic && input) return "ロジックと入力データの両方が更新されました。";
        if (logic) return "入力データは同一で、ロジックが更新されました。";
        if (readiness) return "ロジック変更なし。入力の利用可否が変化しました。";
        if (input) return "ロジック変更なし。入力データ更新によりOverallが変化しました。";
        return "ロジックと入力データに変更はありません。";
    }
    function unavailable(response) {
        const invalid = response?.persistenceStatus === "trace_invalid";
        return freeze({ status: invalid ? "invalid" : "unavailable",
            reason: response?.reason || "trace_unavailable",
            authority: { source: "overall-v2-trace", sourceClass: "formal_history",
                origin: "history", formalStatus: invalid ? "invalid" : "unavailable",
                versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "not_applicable", reason: "formal_trace_history" },
            summary: { availability: response?.persistenceStatus || "trace_unavailable",
                persistenceStatus: response?.persistenceStatus || "trace_unavailable" },
            details: null });
    }
    function exportSection(response) {
        if (response?.status !== "available" || !response.current) return unavailable(response);
        const current = response.current, previous = response.previous, change = response.change;
        const changedComponents = ["option", "weekly"].filter(name => {
            const value = change?.componentDeltas?.[name];
            return value && (value.inputIdentityChanged || value.readinessChanged ||
                value.weightedContribution?.delta !== 0);
        });
        const readinessChanged = ["overall", "option", "weekly"].some(name =>
            change?.readinessChanges?.[name]?.changed === true);
        const fallbackChanged = change?.fallbackChanges?.option?.usingFallbackChanged === true ||
            change?.fallbackChanges?.option?.referenceStateChanged === true ||
            change?.fallbackChanges?.weekly?.originChanged === true;
        return freeze({ status: "available", reason: null,
            authority: { source: "overall-v2-trace", sourceClass: "formal_history",
                origin: "history", formalStatus: "verified", versionKey: current.versionKey,
                signature: current.signature },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: current.acceptedAt },
            freshness: { status: "not_applicable", reason: "formal_trace_history" },
            summary: { availability: "trace_saved", persistenceStatus: "trace_saved",
                observationId: current.observationId, observedAt: current.observedAt,
                calendarDay: current.calendarDay, sessionIdentity: clone(current.sessionIdentity),
                logicIdentityHash: current.logicIdentityHash,
                inputSetIdentityHash: current.inputSetIdentityHash,
                direction: current.direction, directionLabel: current.directionLabel,
                confidence: current.confidence, coverage: current.coverage,
                coverageSemantic: current.coverageSemantic,
                basis: "accepted_overall_v2_trace", previousObservationId:
                    previous?.observationId || null, classification: change?.classification || null,
                directionDelta: change?.outputDelta?.direction?.delta ?? null,
                confidenceDelta: change?.outputDelta?.confidence?.delta ?? null,
                coverageDelta: change?.outputDelta?.coverage?.delta ?? null,
                changedComponents, logicChanged: change?.logicIdentityChanges?.changed ?? false,
                inputChanged: change?.inputIdentityChanges?.changed ?? false,
                readinessChanged, fallbackChanged,
                additiveAttributionAvailable:
                    change?.contributionExplanation?.additiveAttributionSupported ?? false,
                additiveAttributionReason: change?.contributionExplanation?.reason ||
                    (change?.classification === "first_observation" ? "no_previous_trace" : null),
                explanation: hint(change) },
            details: { current: { observationId: current.observationId,
                observedAt: current.observedAt, acceptedAt: current.acceptedAt,
                observationSlot: clone(current.observationSlot),
                logicIdentityHash: current.logicIdentityHash,
                inputSetIdentityHash: current.inputSetIdentityHash,
                result: { status: current.status, direction: current.direction,
                    directionLabel: current.directionLabel, confidence: current.confidence,
                    coverage: current.coverage,
                    coverageSemantic: current.coverageSemantic },
                components: { option: component(current.componentSnapshots?.option,
                    change?.componentDeltas?.option, "option"),
                weekly: component(current.componentSnapshots?.weekly,
                    change?.componentDeltas?.weekly, "weekly") } },
            previous: previous ? { observationId: previous.observationId,
                observedAt: previous.observedAt, acceptedAt: previous.acceptedAt,
                logicIdentityHash: previous.logicIdentityHash,
                inputSetIdentityHash: previous.inputSetIdentityHash } : null,
            change: { deltaId: change?.deltaId || null, comparability: change?.comparability || null,
                reason: change?.reason || null, classification: change?.classification || null,
                outputDelta: clone(change?.outputDelta || null),
                confidenceFactorDeltas: clone(change?.confidenceFactorDeltas || null),
                logicIdentityChanges: clone(change?.logicIdentityChanges || null),
                inputIdentityChanges: clone(change?.inputIdentityChanges || null),
                readinessChanges: clone(change?.readinessChanges || null),
                fallbackChanges: clone(change?.fallbackChanges || null),
                contributionExplanation: clone(change?.contributionExplanation || null) } } });
    }
    return freeze({ exportSection, hint });
});
