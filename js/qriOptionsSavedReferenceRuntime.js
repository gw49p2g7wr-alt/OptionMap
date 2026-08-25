(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const analysisApi = commonJs ? require("./qriOptionsSavedReferenceAnalysis.js") :
        root?.OptionMapQriOptionsSavedReferenceAnalysis;
    const uiApi = commonJs ? require("./qriOptionsSavedReferenceUiState.js") :
        root?.OptionMapQriOptionsSavedReferenceUiState;
    const api = factory(analysisApi, uiApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsSavedReferenceRuntime = api;
})(typeof window !== "undefined" ? window : globalThis,
function (analysisApi, uiApi) {
    "use strict";

    const RUNTIME_VERSION = 1;

    function clone(value) {
        if (value == null) return value;
        return typeof structuredClone === "function" ? structuredClone(value) :
            JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function identity(display, candidate) {
        const source = display?.sourceState || {};
        const metadata = source.metadata || {};
        return { contract: text(source.contract) || text(metadata.contract),
            tradingDate: text(metadata.tradingDate), pageUpdatedAt: text(metadata.pageUpdatedAt),
            fetchedAt: text(metadata.fetchedAt) || text(candidate?.fetchedAt),
            canonicalSignature: text(candidate?.canonicalSignature),
            canonicalVersionKey: text(candidate?.canonicalVersionKey),
            displayGeneration: Number.isSafeInteger(display?.generation)
                ? display.generation : null };
    }

    function identityKey(value) {
        if (!value) return null;
        return [value.contract, value.canonicalVersionKey,
            value.displayGeneration].join("|");
    }

    function prepared(display, candidate) {
        const source = clone(display?.sourceState) || {};
        const positions = clone(display?.positionsState) || {};
        const value = identity(display, candidate);
        source.canonicalSignature = value.canonicalSignature;
        source.canonicalVersionKey = value.canonicalVersionKey;
        source.displayGeneration = value.displayGeneration;
        source.metadata = { ...(source.metadata || {}), ...value };
        positions.canonicalSignature = value.canonicalSignature;
        positions.canonicalVersionKey = value.canonicalVersionKey;
        positions.displayGeneration = value.displayGeneration;
        positions.metadata = { ...(positions.metadata || {}), ...value };
        return { displaySourceState: source, displayPositionsState: positions,
            identity: value };
    }

    function elements(documentRef) {
        const get = id => documentRef?.getElementById?.(id) || null;
        return { region: get("qriOptionsSavedReferenceState"),
            title: get("qriOptionsSavedReferenceTitle"),
            subtitle: get("qriOptionsSavedReferenceSubtitle"),
            callLabel: get("qriOptionsSavedReferenceCallLabel"),
            callList: get("qriOptionsSavedReferenceCallList"),
            callEmpty: get("qriOptionsSavedReferenceCallEmpty"),
            putLabel: get("qriOptionsSavedReferencePutLabel"),
            putList: get("qriOptionsSavedReferencePutList"),
            putEmpty: get("qriOptionsSavedReferencePutEmpty"),
            metadata: get("qriOptionsSavedReferenceMetadata"),
            note: get("qriOptionsSavedReferenceNote") };
    }

    function clearElement(element) {
        if (!element) return;
        element.textContent = "";
        if (typeof element.replaceChildren === "function") element.replaceChildren();
    }

    function clearQriOptionsSavedReferenceDom(documentRef) {
        const dom = elements(documentRef);
        if (!dom.region) return deepFreeze({ rendered: false, reason: "dom_missing" });
        dom.region.hidden = true;
        for (const [name, element] of Object.entries(dom)) {
            if (name !== "region") clearElement(element);
        }
        return deepFreeze({ rendered: true, visible: false });
    }

    function renderItems(documentRef, list, items) {
        clearElement(list);
        for (const item of items) {
            const row = documentRef.createElement("li");
            row.textContent = item.text;
            if (item.isMaximum === true) {
                const marker = documentRef.createElement("span");
                marker.className = "qri-options-saved-reference-maximum";
                marker.textContent = "最大";
                row.appendChild(marker);
            }
            list.appendChild(row);
        }
    }

    function renderQriOptionsSavedReferenceUi(uiState, documentRef) {
        if (uiState?.visible !== true) return clearQriOptionsSavedReferenceDom(documentRef);
        const dom = elements(documentRef);
        if (Object.values(dom).some(element => !element)) {
            return deepFreeze({ rendered: false, reason: "dom_missing" });
        }
        dom.region.hidden = false;
        dom.region.dataset.severity = uiState.severity;
        dom.title.textContent = uiState.title;
        dom.subtitle.textContent = uiState.subtitle;
        dom.callLabel.textContent = uiState.call.label;
        renderItems(documentRef, dom.callList, uiState.call.topItems);
        dom.callEmpty.hidden = !uiState.call.emptyText;
        dom.callEmpty.textContent = uiState.call.emptyText || "";
        dom.putLabel.textContent = uiState.put.label;
        renderItems(documentRef, dom.putList, uiState.put.topItems);
        dom.putEmpty.hidden = !uiState.put.emptyText;
        dom.putEmpty.textContent = uiState.put.emptyText || "";
        dom.metadata.textContent = uiState.metadataLines.map(line => line.text).join(" / ");
        dom.note.textContent = uiState.note;
        return deepFreeze({ rendered: true, visible: true });
    }

    function getQriOptionsSavedReferenceDomState(documentRef) {
        const dom = elements(documentRef);
        const items = list => Array.from(list?.children || []).map(item => ({
            text: item.childNodes?.[0]?.textContent || item.textContent || null,
            maximum: Array.from(item.children || []).some(child =>
                child.className === "qri-options-saved-reference-maximum")
        }));
        return deepFreeze({ visible: dom.region?.hidden === false,
            title: dom.title?.textContent || null,
            subtitle: dom.subtitle?.textContent || null,
            call: { label: dom.callLabel?.textContent || null,
                items: items(dom.callList), empty: dom.callEmpty?.textContent || null },
            put: { label: dom.putLabel?.textContent || null,
                items: items(dom.putList), empty: dom.putEmpty?.textContent || null },
            metadata: dom.metadata?.textContent || null,
            note: dom.note?.textContent || null });
    }

    function createQriOptionsSavedReferenceRuntime({ getDisplayState = () => null,
        getSavedIdentity = () => null,
        buildAnalysis = value => analysisApi?.buildQriOptionsSavedReferenceAnalysis?.(value),
        buildUi = value => uiApi?.buildQriOptionsSavedReferenceUiState?.(value),
        renderUi = () => null, clearUi = () => null } = {}) {
        let sequence = 0;
        let current = deepFreeze({ runtimeVersion: RUNTIME_VERSION,
            status: "not_started", reason: null, generation: 0, identity: null,
            referenceOnly: true, calculationEligible: false,
            analysisState: null, uiState: null });

        function state(status, reason, display, identityValue, analysisState, uiState) {
            current = deepFreeze({ runtimeVersion: RUNTIME_VERSION, status, reason,
                generation: display?.generation ?? 0, identity: clone(identityValue),
                referenceOnly: true, calculationEligible: false,
                analysisState: clone(analysisState), uiState: clone(uiState) });
            return current;
        }

        function getState() { return deepFreeze(clone(current)); }

        async function refresh() {
            const ownSequence = ++sequence;
            const initial = clone(getDisplayState());
            const candidate = clone(getSavedIdentity());
            if (initial?.sourceState?.sourceKind !== "saved") {
                clearUi();
                return state("hidden", "source_not_saved", initial, null, null, null);
            }
            const input = prepared(initial, candidate);
            const analysisState = await buildAnalysis({
                displaySourceState: input.displaySourceState,
                displayPositionsState: input.displayPositionsState });
            const uiState = await buildUi({ referenceAnalysisState: analysisState });
            if (ownSequence !== sequence) {
                return deepFreeze({ applied: false, reason: "stale_sequence" });
            }
            const latest = clone(getDisplayState());
            const latestCandidate = clone(getSavedIdentity());
            const latestInput = prepared(latest, latestCandidate);
            const expectedKey = identityKey(input.identity);
            const latestKey = identityKey(latestInput.identity);
            const analysisKey = identityKey(analysisState?.identity);
            if (latest?.sourceState?.sourceKind !== "saved" ||
                latest?.sourceState?.state !== initial?.sourceState?.state ||
                expectedKey !== latestKey || expectedKey !== analysisKey ||
                uiState?.visible !== true) {
                clearUi();
                return state("hidden", "identity_or_generation_changed", latest,
                    latestInput.identity, analysisState, uiState);
            }
            renderUi(uiState);
            return state("visible", null, latest, latestInput.identity,
                analysisState, uiState);
        }

        return Object.freeze({ refresh, getState });
    }

    return Object.freeze({ RUNTIME_VERSION, createQriOptionsSavedReferenceRuntime,
        renderQriOptionsSavedReferenceUi, clearQriOptionsSavedReferenceDom,
        getQriOptionsSavedReferenceDomState });
});
