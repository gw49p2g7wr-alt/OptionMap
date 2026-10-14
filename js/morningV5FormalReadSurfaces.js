(function (root, factory) {
    const api = factory(root);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningV5FormalReadSurfaces = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
    "use strict";
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    const freeze = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); };
    const records = response => Array.isArray(response?.records) ? response.records.filter(record =>
        record?.observation && record.observationId === record.observation.observationId) : [];
    const observation = record => record?.observation || null;
    function project(response, expectedScope = null) {
        const values = records(response).slice().sort((left, right) =>
            Date.parse(observation(left).observedAt) - Date.parse(observation(right).observedAt) ||
            left.observationId.localeCompare(right.observationId));
        if (response?.status !== "available" || !values.length) return freeze({
            status: response?.status === "unavailable" ? "unavailable" : "missing",
            reason: response?.reason || (response?.status === "unavailable" ?
                "formal_morning_v5_read_failed" : "formal_morning_v5_not_saved"),
            scope: expectedScope, calendarDate: response?.calendarDate || null,
            observations: [], latest: null, timeline: [], supersedesChain: [] });
        const latestRecord = values.at(-1), latest = clone(observation(latestRecord));
        const byId = new Map(values.map(record => [record.observationId, observation(record)]));
        for (const baseline of Array.isArray(response?.baselines) ? response.baselines : []) {
            if (typeof baseline?.observationId === "string" &&
                Number.isFinite(Date.parse(baseline?.observedAt))) byId.set(baseline.observationId,
                { observedAt: baseline.observedAt });
        }
        const baselineId = latest.baselineSelection?.baselineObservationId || null;
        const timeline = values.map(record => ({ observationId: record.observationId,
            observedAt: observation(record).observedAt,
            supersedesObservationId: record.supersedesObservationId }));
        const chain = []; let cursor = latestRecord;
        while (cursor) { chain.unshift(cursor.observationId);
            cursor = cursor.supersedesObservationId ? values.find(item =>
                item.observationId === cursor.supersedesObservationId) : null; }
        return freeze({ status: "available", reason: null, scope: expectedScope,
            calendarDate: response.calendarDate || latest.calendarDay,
            observations: values.map(record => clone(observation(record))), latest,
            baselineObservedAt: baselineId ? byId.get(baselineId)?.observedAt || null : null,
            timeline, supersedesChain: chain });
    }
    function exportSection(response) {
        const value = project(response, "current"), latest = value.latest;
        if (!latest) return freeze({ status: "unavailable",
            reason: value.reason || "formal_morning_v5_not_saved",
            authority: { source: "formal-morning-v5", sourceClass: "formal_history",
                origin: "history", formalStatus: "unavailable", versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "unavailable", reason: "formal_observation_not_saved" },
            summary: null, details: null });
        return freeze({ status: "available", reason: null,
            authority: { source: latest.seriesId, sourceClass: "formal_history", origin: "history",
                formalStatus: "verified", versionKey: latest.versionKey,
                signature: latest.signature },
            asOf: { tradingDate: latest.tradingDate, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: latest.observedAt },
            freshness: clone(latest.freshness),
            summary: { availability: "saved", seriesId: latest.seriesId,
                authorityVersion: latest.authorityVersion, schemaVersion: latest.schemaVersion,
                observationId: latest.observationId, observationSlotId: latest.observationSlotId,
                observedAt: latest.observedAt, calendarDay: latest.calendarDay,
                tradingDate: latest.tradingDate, qriContract: latest.contractContext.qriContract,
                futuresContract: latest.contractContext.futuresContract,
                contractRelation: latest.contractContext.relation,
                aggregateComparison: latest.comparison.aggregateClass },
            details: { sourceIdentities: clone(latest.sourceIdentities),
                contractContext: clone(latest.contractContext), freshness: clone(latest.freshness),
                baselineSelection: clone(latest.baselineSelection), comparison: clone(latest.comparison),
                calculationVersion: latest.calculationVersion, versionKey: latest.versionKey } });
    }
    const text = (document, parent, tag, value, className = "") => { const node = document.createElement(tag);
        node.className = className; node.textContent = value; parent.appendChild(node); return node; };
    function render(container, value, { historical = false } = {}) {
        if (!container) return value; container.replaceChildren();
        text(container.ownerDocument, container, "h3", "Formal Morning V5");
        if (!value.latest) { text(container.ownerDocument, container, "p",
            historical ? "Formal Morning V5 保存なし" : "Formal Morning V5：利用不可（保存なし）",
            "time-travel-empty"); return value; }
        const latest = value.latest, baseline = latest.baselineSelection;
        text(container.ownerDocument, container, "p", `status：available ／ observedAt：${latest.observedAt}`);
        text(container.ownerDocument, container, "p", `calendarDay：${latest.calendarDay} ／ tradingDate：${latest.tradingDate}`);
        text(container.ownerDocument, container, "p", `QRI：${latest.contractContext.qriContract} ／ Futures：${latest.contractContext.futuresContract}`);
        text(container.ownerDocument, container, "p", `contractRelation：${latest.contractContext.relation}`);
        text(container.ownerDocument, container, "p", `freshness：${latest.freshness.status} ／ policy：${latest.freshness.policyVersion} ／ session：${latest.freshness.sessionIdentity || "—"} ／ quote：${latest.sourceIdentities.futures.quotedAtNormalized}`);
        text(container.ownerDocument, container, "p", baseline.baselineObservationId ?
            `baseline：${baseline.baselineObservationId} ／ ${value.baselineObservedAt || "時刻不明"} ／ ${baseline.ruleVersion}` :
            `baseline：first_observation ／ ${baseline.ruleVersion}`);
        text(container.ownerDocument, container, "p", `supply：${latest.comparison.supply.comparable ? "comparable" : latest.comparison.supply.reason} ／ price：${latest.comparison.price.comparable ? "comparable" : latest.comparison.price.reason} ／ aggregate：${latest.comparison.aggregateClass}`);
        if (historical) value.timeline.forEach(item => text(container.ownerDocument, container, "p",
            `${item.observedAt} ／ ${item.observationId} ／ supersedes ${item.supersedesObservationId || "none"}`));
        return value;
    }
    async function initialize() {
        const container = root.document?.getElementById?.("morningV5FormalCurrent");
        if (!container || typeof root.optionMapBridge?.readMorningV5Formal !== "function") return null;
        try { return render(container, project(await root.optionMapBridge.readMorningV5Formal({
            scope: "current" }), "current")); }
        catch (_error) { return render(container, project({ status: "unavailable", records: [] }, "current")); }
    }
    root.document?.addEventListener?.("DOMContentLoaded", initialize);
    return freeze({ project, exportSection, render, initialize });
});
