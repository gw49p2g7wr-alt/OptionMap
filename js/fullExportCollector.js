(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const fullExportApi = commonJs ? require("./fullExport.js") : root?.OptionMapFullExport;
    const qriHistoryApi = commonJs ? require("./qriOptionsHistory.js") :
        root?.OptionMapQriOptionsHistory;
    const qriComparisonApi = commonJs ? require("./qriOptionsHistoryComparison.js") :
        root?.OptionMapQriOptionsHistoryComparison;
    const qriOptionsApi = commonJs ? require("./qriOptions.js") : root?.OptionMapQriOptions;
    const aiSummaryApi = commonJs ? require("./fullExportAiSummary.js") :
        root?.OptionMapFullExportAiSummary;
    const api = factory(fullExportApi, qriHistoryApi, qriComparisonApi, qriOptionsApi,
        aiSummaryApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportCollector = api;
})(typeof globalThis !== "undefined" ? globalThis : this,
function (fullExportApi, qriHistoryApi, qriComparisonApi, qriOptionsApi, aiSummaryApi) {
    "use strict";

    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const validTimestamp = value => text(value) && Number.isFinite(Date.parse(value));
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "");

    function asOf(values = {}) {
        return {
            tradingDate: validDate(values.tradingDate) ? values.tradingDate : null,
            sourceDate: validDate(values.sourceDate) ? values.sourceDate : null,
            snapshotDate: validDate(values.snapshotDate) ? values.snapshotDate : null,
            pageUpdatedAt: validTimestamp(values.pageUpdatedAt) ? values.pageUpdatedAt : null,
            fetchedAt: validTimestamp(values.fetchedAt) ? values.fetchedAt : null,
            confirmedAt: validTimestamp(values.confirmedAt) ? values.confirmedAt : null
        };
    }

    function authority(values = {}) {
        return {
            source: text(values.source),
            sourceClass: text(values.sourceClass),
            origin: text(values.origin),
            formalStatus: text(values.formalStatus),
            versionKey: text(values.versionKey),
            signature: text(values.signature)
        };
    }

    function unavailable(reason, source = null, freshness = null, status = "unavailable") {
        const safeFreshness = freshness?.status === "fresh"
            ? { status: "unavailable", reason: "section_unavailable" }
            : freshness;
        return { status, reason, authority: authority({ source }), asOf: asOf(),
            freshness: clone(safeFreshness || { status: "unavailable",
                reason: "freshness_status_unavailable" }), summary: null, details: null };
    }

    function envelope({ status = "available", reason = null, authority: sourceAuthority = {},
        asOf: sourceAsOf = {}, freshness = {}, summary = null, details = null } = {}) {
        return { status, reason, authority: authority(sourceAuthority), asOf: asOf(sourceAsOf),
            freshness: clone(freshness), summary: clone(summary), details: clone(details) };
    }

    function freshnessFor(configuration, name, observedAt = null, context = null) {
        const provided = configuration.getSectionFreshness?.(name, context);
        if (object(provided) && text(provided.status)) return clone(provided);
        return { status: "unavailable", reason: "freshness_status_unavailable",
            observedAt: validTimestamp(observedAt) ? observedAt : null };
    }

    function createMarketSection(configuration, mobile, marketSession) {
        const price = mobile?.payload?.currentPrice;
        if (!object(price) || price.available !== true) {
            return unavailable("current_price_unavailable", "current-price",
                freshnessFor(configuration, "marketSnapshot", mobile?.freshness?.currentPriceAt));
        }
        const mode = price.mode;
        const identityState = clone(configuration.getCurrentPriceIdentity?.() || null);
        const liveFact = identityState?.status === "available" ? identityState.fact : null;
        const contractMatched = configuration.contractsMatch?.(
            price.contract, liveFact?.contract) === true;
        const automaticValid = mode === "automatic" && liveFact?.available === true &&
            liveFact.sourceKind === "live" && liveFact.origin === "live" &&
            liveFact.mode === "automatic" && liveFact.identityVerified === true &&
            liveFact.acquisitionVerified === true && liveFact.currentRequestVerified === true &&
            contractMatched;
        const manualValid = mode === "manual";
        if (!automaticValid && !manualValid) {
            return unavailable("current_price_identity_mismatch", "current-price",
                freshnessFor(configuration, "marketSnapshot", mobile?.freshness?.currentPriceAt));
        }
        return envelope({ authority: { source: price.source,
            sourceClass: automaticValid ? "formal_live" : "user_input",
            origin: automaticValid ? "live" : "manual",
            formalStatus: automaticValid ? "verified" : "unverified" },
        asOf: { tradingDate: marketSession?.tradingDate || null,
            fetchedAt: price.fetchedAt || null },
        freshness: freshnessFor(configuration, "marketSnapshot",
            price.quotedAt || price.fetchedAt),
        summary: { available: true, value: price.value, mode: price.mode,
            source: price.source, contract: price.contract || null },
        details: { quotedAt: price.quotedAt || null, fetchedAt: price.fetchedAt || null,
            identity: automaticValid ? clone(liveFact) : { mode: "manual" },
            marketDate: mobile?.marketDate || null,
            marketSessionStatus: marketSession?.status || "unavailable" } });
    }

    function createOverallSection(configuration) {
        const state = clone(configuration.getOverallV2FormalEnvelope?.() || null);
        const envelopeValue = state?.envelope;
        if (state?.status !== "available" || !object(envelopeValue) ||
            envelopeValue.formalApplied !== true || envelopeValue.identityVerified !== true ||
            !object(envelopeValue.result)) {
            return unavailable(state?.reason || "formal_overall_unavailable", "overall-v2",
                freshnessFor(configuration, "overallV2"));
        }
        const result = envelopeValue.result;
        const status = ["complete", "partial"].includes(result.status)
            ? result.status === "complete" ? "available" : "partial" : "invalid";
        if (status === "invalid") return unavailable("formal_overall_invalid", "overall-v2",
            freshnessFor(configuration, "overallV2"), "invalid");
        return envelope({ status, reason: status === "partial" ? "overall_v2_partial" : null,
            authority: { source: "overall-v2", sourceClass: "formal_envelope",
                origin: "runtime", formalStatus: "verified",
                versionKey: envelopeValue.logicVersion,
                signature: envelopeValue.inputFingerprint },
            freshness: freshnessFor(configuration, "overallV2", envelopeValue.evaluatedAt),
            summary: { status: result.status, direction: result.direction,
                directionLabel: result.directionLabel, confidence: result.confidence,
                coverage: result.metadata?.coverage ?? null,
                interpretation: fullExportApi.SAFE_INTERPRETATION },
            details: { evaluatedAt: envelopeValue.evaluatedAt || null,
                result: clone(result), optionSourceIdentity: clone(envelopeValue.optionSourceIdentity || null),
                weeklySourceIdentity: clone(envelopeValue.weeklySourceIdentity || null) } });
    }

    function createMorningSection(configuration) {
        const restore = clone(configuration.getMorningRestoreState?.() || null);
        const runtime = clone(configuration.getMorningComparisonState?.() || null);
        const restoreValid = restore?.restoreStatus === "valid" &&
            restore.integrityStatus === "valid" && restore.applicabilityStatus === "applicable" &&
            restore.diagnostics?.selectedActiveRevision === true &&
            restore.diagnostics?.baselineValidated !== false;
        const comparison = runtime?.comparison;
        const comparable = runtime?.status === "available" && runtime.available === true &&
            comparison?.status === "comparable" && comparison.available === true;
        if (!restoreValid || !comparable ||
            runtime.selectedBaselineId !== restore.selectedBaselineId) {
            return unavailable(!restoreValid ? "morning_baseline_not_applicable" :
                runtime?.reason || "morning_comparison_unavailable", "morning-v4",
            freshnessFor(configuration, "morning", runtime?.publishedAt));
        }
        const divergence = comparison.divergence || {};
        return envelope({ authority: { source: "morning-v4", sourceClass: "formal_runtime",
            origin: "runtime", formalStatus: "verified",
            versionKey: runtime.selectedBaselineId },
        asOf: { tradingDate: runtime.formalTradingDate || null,
            confirmedAt: restore.baseline?.capturedAt || null },
        freshness: freshnessFor(configuration, "morning", runtime.publishedAt),
        summary: { priceDelta: divergence.priceDelta ?? null,
            supplyDemandDelta: divergence.supplyDemandDelta ?? null,
            relation: divergence.relation || null,
            qualityTransition: comparison.dataQuality?.transition || null },
        details: { baselineIdentity: clone(runtime.baselineIdentity || null),
            currentIdentity: clone(runtime.currentIdentity || null),
            comparison: clone(comparison) } });
    }

    async function createQriSections(configuration) {
        const identityState = clone(configuration.getQriFormalIdentity?.() || null);
        const fact = identityState?.status === "available" ? identityState.fact : null;
        const qriFreshness = freshnessFor(configuration, "qriOptions", fact?.pageUpdatedAt);
        if (!fact || fact.sourceClass !== "formal_live" || fact.origin !== "live" ||
            fact.identityVerified !== true || fact.acquisitionVerified !== true ||
            fact.usingFallback === true || fact.referenceOnly === true) {
            return { qriOptions: unavailable(identityState?.reason || "formal_qri_unavailable",
                "qri-nikkei225-options", qriFreshness),
            qriHistoryComparison: unavailable("formal_qri_unavailable",
                "formal_qri_options_history", freshnessFor(configuration, "qriHistoryComparison")),
            comparison: null };
        }
        let loaded;
        try { loaded = clone(await configuration.readQriHistory?.()); }
        catch (_error) {
            return { qriOptions: unavailable("qri_history_read_failed",
                "qri-nikkei225-options", qriFreshness),
            qriHistoryComparison: unavailable("qri_history_read_failed",
                "formal_qri_options_history", freshnessFor(configuration, "qriHistoryComparison")),
            comparison: null };
        }
        const validation = await (configuration.validateQriHistory ||
            qriHistoryApi?.validateHistory)?.(loaded?.history);
        if (loaded?.status !== "ready" || validation?.valid !== true) {
            return { qriOptions: unavailable("qri_history_invalid", "qri-nikkei225-options",
                qriFreshness, "invalid"),
            qriHistoryComparison: unavailable("qri_history_invalid",
                "formal_qri_options_history", freshnessFor(configuration, "qriHistoryComparison"),
            "invalid"), comparison: null };
        }
        const entry = loaded.history.entries.find(item => item.contract === fact.contract &&
            item.sourceDateKey === fact.tradingDate);
        const revision = entry?.revisions?.find(item => item.versionKey === entry.activeVersionKey);
        if (!revision || entry.activeVersionKey !== fact.canonicalVersionKey) {
            return { qriOptions: unavailable("formal_revision_not_found",
                "qri-nikkei225-options", qriFreshness),
            qriHistoryComparison: unavailable("formal_revision_not_found",
                "formal_qri_options_history", freshnessFor(configuration, "qriHistoryComparison")),
            comparison: null };
        }
        const identityMatched = revision.versionKey === fact.canonicalVersionKey &&
            revision.signature === fact.canonicalSignature && revision.contract === fact.contract &&
            revision.tradingDate === fact.tradingDate && revision.canonical?.contract === fact.contract &&
            revision.canonical?.tradingDate === fact.tradingDate &&
            revision.pageUpdatedAt === fact.pageUpdatedAt &&
            revision.canonical?.pageUpdatedAt === fact.pageUpdatedAt;
        if (!identityMatched) {
            return { qriOptions: unavailable("formal_identity_mismatch",
                "qri-nikkei225-options", qriFreshness),
            qriHistoryComparison: unavailable("formal_identity_mismatch",
                "formal_qri_options_history", freshnessFor(configuration, "qriHistoryComparison")),
            comparison: null };
        }
        const snapshotDate = qriHistoryApi?.effectiveSnapshotDate?.(revision) ||
            revision.snapshotDate || null;
        const qriOptions = envelope({ authority: { source: "qri-nikkei225-options",
            sourceClass: "formal_history", origin: "history", formalStatus: "verified",
            versionKey: revision.versionKey, signature: revision.signature },
        asOf: { tradingDate: revision.tradingDate, sourceDate: entry.sourceDateKey,
            snapshotDate, pageUpdatedAt: revision.pageUpdatedAt,
            fetchedAt: revision.fetchedAt, confirmedAt: revision.confirmedAt },
        freshness: qriFreshness,
        summary: { contract: revision.contract,
            openInterestStatus: revision.openInterestStatus },
        details: { records: clone(revision.canonical.records),
            canonicalMetadata: { contract: revision.canonical.contract,
                tradingDate: revision.canonical.tradingDate,
                pageUpdatedAt: revision.canonical.pageUpdatedAt,
                openInterestStatus: revision.canonical.openInterestStatus } } });
        let comparison;
        try {
            comparison = clone(await (configuration.compareQriHistory ||
                qriComparisonApi?.compareLatestSavedDates)?.(loaded.history, fact.contract));
        } catch (_error) { comparison = null; }
        if (!comparison || comparison.available !== true || comparison.status !== "comparable" ||
            comparison.currentVersionKey !== revision.versionKey) {
            return { qriOptions, qriHistoryComparison: unavailable(comparison?.reason ||
                "qri_comparison_unavailable", "formal_qri_options_history",
            freshnessFor(configuration, "qriHistoryComparison")), comparison: null };
        }
        const byType = comparison.comparison?.byType || {};
        const highlights = ["call", "put"].map(optionType => ({ optionType,
            netDelta: byType[optionType]?.summary?.netDelta ?? null,
            topIncreases: clone(byType[optionType]?.summary?.topIncreases || []),
            topDecreases: clone(byType[optionType]?.summary?.topDecreases || []),
            newlyPublished: clone(byType[optionType]?.summary?.newlyPublished || []),
            noLongerPublished: clone(byType[optionType]?.summary?.noLongerPublished || []) }));
        const qriHistoryComparison = envelope({ authority: {
            source: "formal_qri_options_history", sourceClass: "formal_history",
            origin: "history", formalStatus: "verified", versionKey: comparison.currentVersionKey },
        asOf: { tradingDate: comparison.currentSourceDate,
            sourceDate: comparison.currentSourceDate, snapshotDate,
            pageUpdatedAt: comparison.currentPageUpdatedAt,
            fetchedAt: revision.fetchedAt, confirmedAt: revision.confirmedAt },
        freshness: freshnessFor(configuration, "qriHistoryComparison"),
        summary: { previousTradingDate: comparison.previousSourceDate,
            currentTradingDate: comparison.currentSourceDate, highlights },
        details: { previousIdentity: { tradingDate: comparison.previousSourceDate,
            versionKey: comparison.previousVersionKey,
            pageUpdatedAt: comparison.previousPageUpdatedAt || null },
        currentIdentity: { tradingDate: comparison.currentSourceDate,
            versionKey: comparison.currentVersionKey,
            pageUpdatedAt: comparison.currentPageUpdatedAt || null },
        comparison: clone(comparison.comparison) } });
        return { qriOptions, qriHistoryComparison, comparison };
    }

    function nextContractAcquisition(configuration) {
        const state = clone(configuration.getQriReferenceAcquisitionState?.() || null);
        return object(state?.acquisition) ? state.acquisition : state;
    }

    function aggregatePublishedRecords(records, optionType) {
        const typed = records.filter(record => record.optionType === optionType);
        const published = typed.filter(record => record.published === true);
        return { value: published.reduce((sum, record) => sum + record.value, 0),
            publishedRecordCount: published.length,
            unpublishedRecordCount: typed.filter(record => record.published === false).length };
    }

    async function createQriNextContractSection(configuration) {
        const acquisition = nextContractAcquisition(configuration);
        const status = text(acquisition?.status);
        if (!status) return unavailable("next_contract_acquisition_missing",
            "qri-nikkei225-options", freshnessFor(configuration,
                "qriOptionsNextContract", null, { acquisition: null, revision: null }));
        if (!["saved", "unchanged"].includes(status)) {
            return unavailable(`next_contract_acquisition_${status}`,
                "qri-nikkei225-options", freshnessFor(configuration,
                    "qriOptionsNextContract", null, { acquisition, revision: null }));
        }
        const targetContract = text(acquisition.targetContract);
        const tradingDate = validDate(acquisition.referenceTradingDate)
            ? acquisition.referenceTradingDate : null;
        const versionKey = text(acquisition.versionKey);
        if (!targetContract || !tradingDate || !versionKey) {
            return unavailable("next_contract_locator_invalid", "qri-nikkei225-options",
                freshnessFor(configuration, "qriOptionsNextContract", null,
                    { acquisition, revision: null }));
        }
        let loaded;
        try { loaded = clone(await configuration.readQriHistory?.()); }
        catch (_error) { return unavailable("next_contract_history_read_failed",
            "qri-nikkei225-options", freshnessFor(configuration,
                "qriOptionsNextContract", null, { acquisition, revision: null })); }
        const validation = await (configuration.validateQriHistory ||
            qriHistoryApi?.validateHistory)?.(loaded?.history);
        if (loaded?.status !== "ready" || validation?.valid !== true) {
            return unavailable("next_contract_history_invalid", "qri-nikkei225-options",
                freshnessFor(configuration, "qriOptionsNextContract", null,
                    { acquisition, revision: null }), "invalid");
        }
        const entry = loaded.history.entries.find(item => item.entryKey ===
            `${targetContract}|${tradingDate}`);
        const revision = entry?.revisions?.find(item => item.versionKey === entry.activeVersionKey);
        const canonical = revision?.canonical;
        const locatorMatched = entry?.contract === targetContract &&
            entry?.sourceDateKey === tradingDate && entry?.activeVersionKey === versionKey &&
            revision?.versionKey === versionKey && revision?.contract === targetContract &&
            revision?.tradingDate === tradingDate && canonical?.contract === targetContract &&
            canonical?.tradingDate === tradingDate &&
            text(acquisition.targetUrl) === revision?.sourceUrl &&
            canonical?.sourceUrl === revision?.sourceUrl &&
            canonical?.pageUpdatedAt === revision?.pageUpdatedAt &&
            text(revision?.signature) !== null;
        if (!locatorMatched) return unavailable("next_contract_identity_mismatch",
            "qri-nikkei225-options", freshnessFor(configuration,
                "qriOptionsNextContract", null, { acquisition, revision: null }));
        let signature = null;
        try { signature = await qriOptionsApi?.createSignature?.(canonical); }
        catch (_error) { signature = null; }
        if (!signature || signature !== revision.signature) {
            return unavailable("next_contract_signature_mismatch", "qri-nikkei225-options",
                freshnessFor(configuration, "qriOptionsNextContract", null,
                    { acquisition, revision: null }), "invalid");
        }
        const snapshotDate = qriHistoryApi?.effectiveSnapshotDate?.(revision) ||
            revision.snapshotDate || null;
        const sectionFreshness = freshnessFor(configuration, "qriOptionsNextContract",
            revision.pageUpdatedAt, { acquisition, revision });
        const records = clone(canonical.records);
        return envelope({ authority: { source: "qri-nikkei225-options",
            sourceClass: "formal_history", origin: "history", formalStatus: "verified",
            versionKey: revision.versionKey, signature: revision.signature },
        asOf: { tradingDate: revision.tradingDate, sourceDate: entry.sourceDateKey,
            snapshotDate, pageUpdatedAt: revision.pageUpdatedAt,
            fetchedAt: revision.fetchedAt, confirmedAt: revision.confirmedAt },
        freshness: sectionFreshness,
        summary: { contract: revision.contract, tradingDate: revision.tradingDate,
            openInterestStatus: revision.openInterestStatus,
            callAggregate: aggregatePublishedRecords(records, "call"),
            putAggregate: aggregatePublishedRecords(records, "put") },
        details: { versionKey: revision.versionKey, signature: revision.signature,
            records, warnings: [] } });
    }

    async function createQriMajorSqNextContractSection(configuration) {
        const locator = clone(configuration.getQriMajorSqFormalHistoryLocator?.() || null);
        if (!object(locator)) return unavailable("major_sq_locator_unavailable",
            "qri-nikkei225-options", freshnessFor(configuration,
                "qriOptionsMajorSqNextContract", null, { locator: null, revision: null }));
        if (!["saved", "unchanged"].includes(locator.status)) {
            return unavailable(`major_sq_acquisition_${text(locator.status) || "unavailable"}`,
                "qri-nikkei225-options", freshnessFor(configuration,
                    "qriOptionsMajorSqNextContract", null, { locator, revision: null }));
        }
        const targetContract = text(locator.targetContract);
        const tradingDate = validDate(locator.referenceTradingDate)
            ? locator.referenceTradingDate : null;
        const targetUrl = text(locator.targetUrl);
        const versionKey = text(locator.versionKey);
        if (!targetContract || !tradingDate || !targetUrl || !versionKey) {
            return unavailable("major_sq_locator_invalid", "qri-nikkei225-options",
                freshnessFor(configuration, "qriOptionsMajorSqNextContract", null,
                    { locator, revision: null }));
        }
        let loaded;
        try { loaded = clone(await configuration.readQriHistory?.()); }
        catch (_error) { return unavailable("major_sq_history_read_failed",
            "qri-nikkei225-options", freshnessFor(configuration,
                "qriOptionsMajorSqNextContract", null, { locator, revision: null })); }
        const validation = await (configuration.validateQriHistory ||
            qriHistoryApi?.validateHistory)?.(loaded?.history);
        if (loaded?.status !== "ready" || validation?.valid !== true) {
            return unavailable("major_sq_history_invalid", "qri-nikkei225-options",
                freshnessFor(configuration, "qriOptionsMajorSqNextContract", null,
                    { locator, revision: null }), "invalid");
        }
        const entries = loaded.history.entries.filter(item => item.entryKey ===
            `${targetContract}|${tradingDate}`);
        const entry = entries.length === 1 ? entries[0] : null;
        const activeRevisions = entry?.revisions?.filter(item =>
            item.versionKey === entry.activeVersionKey) || [];
        const revision = activeRevisions.length === 1 ? activeRevisions[0] : null;
        const canonical = revision?.canonical;
        const locatorMatched = entry?.contract === targetContract &&
            entry?.sourceDateKey === tradingDate && entry?.activeVersionKey === versionKey &&
            revision?.versionKey === versionKey && revision?.contract === targetContract &&
            revision?.tradingDate === tradingDate && revision?.sourceUrl === targetUrl &&
            canonical?.contract === targetContract && canonical?.tradingDate === tradingDate &&
            canonical?.sourceUrl === targetUrl && canonical?.sourceUrl === revision?.sourceUrl &&
            canonical?.pageUpdatedAt === revision?.pageUpdatedAt &&
            text(revision?.signature) !== null;
        if (!locatorMatched) return unavailable("major_sq_identity_mismatch",
            "qri-nikkei225-options", freshnessFor(configuration,
                "qriOptionsMajorSqNextContract", null, { locator, revision: null }));
        let signature = null;
        try { signature = await qriOptionsApi?.createSignature?.(canonical); }
        catch (_error) { signature = null; }
        if (!signature || signature !== revision.signature) {
            return unavailable("major_sq_signature_mismatch", "qri-nikkei225-options",
                freshnessFor(configuration, "qriOptionsMajorSqNextContract", null,
                    { locator, revision: null }), "invalid");
        }
        const snapshotDate = qriHistoryApi?.effectiveSnapshotDate?.(revision) ||
            revision.snapshotDate || null;
        const sectionFreshness = freshnessFor(configuration,
            "qriOptionsMajorSqNextContract", revision.pageUpdatedAt, { locator, revision });
        const records = clone(canonical.records);
        return envelope({ authority: { source: "qri-nikkei225-options",
            sourceClass: "formal_history", origin: "history", formalStatus: "verified",
            versionKey: revision.versionKey, signature: revision.signature },
        asOf: { tradingDate: revision.tradingDate, sourceDate: entry.sourceDateKey,
            snapshotDate, pageUpdatedAt: revision.pageUpdatedAt,
            fetchedAt: revision.fetchedAt, confirmedAt: revision.confirmedAt },
        freshness: sectionFreshness,
        summary: { contract: revision.contract, tradingDate: revision.tradingDate,
            openInterestStatus: revision.openInterestStatus,
            callAggregate: aggregatePublishedRecords(records, "call"),
            putAggregate: aggregatePublishedRecords(records, "put") },
        details: { versionKey: revision.versionKey, signature: revision.signature,
            records, warnings: [] } });
    }

    function createImportantLevelsSection(configuration, mobile, qriSection) {
        const levels = mobile?.payload?.nearestLevels;
        if (qriSection.status !== "available" || !object(levels)) {
            return unavailable("important_levels_unavailable", "mobile-summary",
                freshnessFor(configuration, "importantLevels"));
        }
        return envelope({ authority: { source: "mobile-summary-nearest-levels",
            sourceClass: "verified_projection", origin: "runtime", formalStatus: "derived" },
        asOf: qriSection.asOf, freshness: freshnessFor(configuration, "importantLevels",
            mobile?.freshness?.qriAt), summary: clone(levels), details: null });
    }

    async function createWeeklyFuturesSection(configuration) {
        const identityState = clone(configuration.getWeeklyFormalIdentity?.() || null);
        const fact = identityState?.status === "available" ? identityState.fact : null;
        if (!fact || fact.sourceClass !== "formal_history" ||
            fact.origin !== "weekly_futures_history" ||
            fact.dataStatus !== "formal_history" || fact.activeVersionMatched !== true ||
            !text(fact.sourceFingerprint)) return unavailable(
            identityState?.reason || "weekly_formal_identity_unavailable", "weekly-futures",
            freshnessFor(configuration, "weeklyFutures"));
        let versions;
        try { versions = clone(await configuration.readWeeklyFuturesActiveVersions?.()); }
        catch (_error) { return unavailable("weekly_futures_read_failed", "weekly-futures",
            freshnessFor(configuration, "weeklyFutures")); }
        const previous = versions?.find(item => item.versionKey === fact.previousVersionKey);
        const current = versions?.find(item => item.versionKey === fact.currentVersionKey);
        if (!previous || !current) return unavailable("formal_revision_not_found", "weekly-futures",
            freshnessFor(configuration, "weeklyFutures"));
        if (current.signature !== fact.currentSignature || current.sourceDate !== fact.sourceDate) {
            return unavailable("formal_identity_mismatch", "weekly-futures",
                freshnessFor(configuration, "weeklyFutures"));
        }
        const candidate = clone(configuration.getWeeklyCandidate?.() || null);
        const twelve = clone(configuration.getTwelveGroup?.() || null);
        const majorMatched = candidate?.available === true &&
            candidate.metadata?.previous?.versionKey === previous.versionKey &&
            candidate.metadata?.current?.versionKey === current.versionKey &&
            candidate.metadata?.activeVersionMatched === true;
        const twelveMatched = twelve?.pairIdentity?.previous?.versionKey === previous.versionKey &&
            twelve?.pairIdentity?.current?.versionKey === current.versionKey;
        return envelope({ authority: { source: "jpx-weekly-index-futures-open-interest-history",
            sourceClass: "formal_history", origin: "history", formalStatus: "verified",
            versionKey: current.versionKey, signature: current.signature },
        asOf: { sourceDate: current.sourceDate, fetchedAt: null,
            confirmedAt: current.savedAt, pageUpdatedAt: current.listingUpdatedAt },
        freshness: freshnessFor(configuration, "weeklyFutures", current.savedAt),
        summary: { major5: majorMatched ? clone(candidate.judgment) : null,
            twelveGroup: twelveMatched ? clone(twelve.groups12) : null,
            agreement: twelveMatched ? clone(twelve.comparison || null) : null,
            major5Status: majorMatched ? "available" : "unavailable",
            twelveGroupStatus: twelveMatched && twelve.status === "available"
                ? "available" : "unavailable" },
        details: { previousIdentity: { sourceDate: previous.sourceDate,
            versionKey: previous.versionKey, signature: previous.signature },
        currentIdentity: { sourceDate: current.sourceDate,
            versionKey: current.versionKey, signature: current.signature },
        records: clone(current.futureOpenInterest?.records || null) } });
    }

    async function createWeeklyOptionsSection(configuration) {
        let loaded;
        try { loaded = clone(await configuration.readWeeklyOptionsHistory?.()); }
        catch (_error) { return unavailable("weekly_options_read_failed", "weekly-options",
            freshnessFor(configuration, "weeklyOptions")); }
        const validation = await configuration.validateWeeklyOptionsHistory?.(loaded?.history);
        if (loaded?.status !== "ready" || validation?.valid !== true) return unavailable(
            "weekly_options_history_invalid", "weekly-options",
            freshnessFor(configuration, "weeklyOptions"), "invalid");
        let comparison;
        try { comparison = clone(await configuration.compareWeeklyOptionsHistory?.(loaded.history)); }
        catch (_error) { comparison = null; }
        const currentVersionKey = comparison?.currentVersionKey;
        const entry = loaded.history.entries.find(item => item.activeVersionKey === currentVersionKey);
        const revision = entry?.revisions?.find(item => item.versionKey === entry.activeVersionKey);
        if (!revision || comparison?.source !== "formal_weekly_options_history") return unavailable(
            "weekly_options_formal_revision_not_found", "weekly-options",
            freshnessFor(configuration, "weeklyOptions"));
        return envelope({ status: comparison.available === true ? "available" : "partial",
            reason: comparison.available === true ? null : comparison.reason || "comparison_unavailable",
            authority: { source: "jpx-weekly-nikkei225-options-open-interest-history",
                sourceClass: "formal_history", origin: "history", formalStatus: "verified",
                versionKey: revision.versionKey, signature: revision.signature },
            asOf: { sourceDate: entry.sourceDate, fetchedAt: revision.fetchedAt,
                confirmedAt: revision.confirmedAt,
                pageUpdatedAt: revision.officialMetadata?.listingUpdatedAt || null },
            freshness: freshnessFor(configuration, "weeklyOptions", revision.confirmedAt),
            summary: { expiry: revision.canonical?.optionExpiries?.call || null,
                comparisonStatus: comparison.status, counts: clone(comparison.counts || null) },
            details: { records: clone(revision.canonical?.records || null),
                comparison: clone(comparison) } });
    }

    async function createParticipantSection(configuration) {
        let source;
        try { source = clone(await configuration.readParticipants?.()); }
        catch (_error) { return unavailable("participant_read_failed", "participants",
            freshnessFor(configuration, "participants")); }
        if (!source || !["available", "partial"].includes(source.status)) return unavailable(
            source?.reason || "participant_unavailable", "participants",
            freshnessFor(configuration, "participants", source?.fetchedAt));
        let validated = false;
        try { validated = await configuration.validateParticipants?.(clone(source)) === true; }
        catch (_error) { validated = false; }
        if (!validated) return unavailable("participant_validation_failed", "participants",
            freshnessFor(configuration, "participants", source.fetchedAt), "invalid");
        const isPartial = source.status === "partial";
        const isHistory = source.origin === "history";
        return envelope({ status: source.status, reason: isPartial
            ? source.reason || "participant_partial" : null,
        authority: { source: "jpx-daily-participant-volume",
            sourceClass: isHistory ? "formal_history" : isPartial
                ? "official_partial" : "validated_live",
            origin: source.origin || null,
            formalStatus: isHistory ? "verified" : isPartial ? "partial" : "validated",
            versionKey: source.versionKey || null, signature: source.signature || null },
        asOf: { sourceDate: source.sourceDate, fetchedAt: source.fetchedAt },
        freshness: freshnessFor(configuration, "participants", source.fetchedAt),
        summary: { fileStatuses: clone(source.fileStatuses || null),
            recordCount: Array.isArray(source.records) ? source.records.length : null },
        details: { records: clone(source.records || null) } });
    }

    async function createIntelligenceSection(configuration) {
        let snapshots;
        try { snapshots = await configuration.readIntelligenceSnapshots?.(); }
        catch (_error) { return unavailable("intelligence_read_failed", "optionmap-intelligence",
            freshnessFor(configuration, "intelligence")); }
        if (!Array.isArray(snapshots)) return unavailable("intelligence_unavailable",
            "optionmap-intelligence", freshnessFor(configuration, "intelligence"));
        const dates = snapshots.map(item => validTimestamp(item?.sourceDate)
            ? item.sourceDate : validTimestamp(item?.savedAt) ? item.savedAt : null).filter(Boolean).sort();
        const days = new Set(dates.map(value => {
            const shifted = new Date(Date.parse(value) + 9 * 60 * 60 * 1000);
            return shifted.toISOString().slice(0, 10);
        }));
        return envelope({ authority: { source: "optionmap-intelligence",
            sourceClass: "derived_summary", origin: "history", formalStatus: "unverified" },
        freshness: freshnessFor(configuration, "intelligence", dates.at(-1)),
        summary: { snapshotCount: snapshots.length, distinctDayCount: days.size,
            firstSnapshotAt: dates[0] || null, latestSnapshotAt: dates.at(-1) || null },
        details: null });
    }

    function compactOverall(section) {
        if (["available", "partial"].includes(section.status)) return clone(section.summary);
        return { status: section.status, direction: null, directionLabel: null,
            confidence: null, coverage: null,
            interpretation: fullExportApi.SAFE_INTERPRETATION };
    }

    function compactMorning(section) {
        return section.status === "available" ? { status: "available", ...clone(section.summary) } :
            { status: section.status, reason: section.reason, priceDelta: null,
                supplyDemandDelta: null, relation: null, qualityTransition: null };
    }

    function createFullExportCollector(configuration = {}) {
        async function collect(options = {}) {
            const generatedAt = configuration.now?.() || new Date().toISOString();
            const mobile = clone(configuration.getMobileSummary?.() || null);
            const marketSession = clone(configuration.getMarketSession?.() || null);
            const marketSnapshot = createMarketSection(configuration, mobile, marketSession);
            const overallV2 = createOverallSection(configuration);
            const morning = createMorningSection(configuration);
            const qri = await createQriSections(configuration);
            const qriOptionsNextContract = await createQriNextContractSection(configuration);
            const qriOptionsMajorSqNextContract =
                await createQriMajorSqNextContractSection(configuration);
            const importantLevels = createImportantLevelsSection(
                configuration, mobile, qri.qriOptions);
            const weeklyFutures = await createWeeklyFuturesSection(configuration);
            const weeklyOptions = await createWeeklyOptionsSection(configuration);
            const participants = await createParticipantSection(configuration);
            const intelligence = await createIntelligenceSection(configuration);
            const sections = { marketSnapshot, overallV2, morning, importantLevels,
                qriOptions: qri.qriOptions,
                qriOptionsNextContract,
                qriOptionsMajorSqNextContract,
                qriHistoryComparison: qri.qriHistoryComparison,
                weeklyFutures, weeklyOptions, participants, intelligence };
            const freshnessIssues = Object.entries(sections)
                .filter(([, section]) => section.freshness?.status !== "fresh")
                .map(([section, value]) => ({ section, status: value.freshness?.status || null,
                    reason: value.freshness?.reason || null }));
            const sourceWarnings = Array.isArray(mobile?.warnings) ? clone(mobile.warnings) : [];
            const availabilityWarnings = Object.entries(sections)
                .filter(([, section]) => ["unavailable", "invalid"].includes(section.status))
                .map(([section, value]) => ({ code: `${section}_${value.status}`,
                    section, reason: value.reason }));
            const warnings = [...sourceWarnings, ...availabilityWarnings];
            const compactSummary = { generatedAt,
                market: options.market || "Nikkei 225 derivatives",
                session: object(marketSession) ? marketSession : { status: "unavailable",
                    calendarDate: null, tradingDate: null },
                currentPrice: marketSnapshot.status === "available"
                    ? clone(marketSnapshot.summary) : { status: marketSnapshot.status,
                        reason: marketSnapshot.reason, value: null, mode: null,
                        source: null, contract: null },
                currentContract: marketSnapshot.summary?.contract ||
                    qri.qriOptions.summary?.contract || null,
                overallV2: compactOverall(overallV2),
                morningChange: compactMorning(morning),
                importantLevels: importantLevels.status === "available"
                    ? clone(importantLevels.summary) : { status: importantLevels.status,
                        reason: importantLevels.reason, upper: null, lower: null },
                qriHighlights: clone(qri.qriHistoryComparison.summary?.highlights || []),
                freshnessIssues, warnings: clone(warnings) };
            const aiSummary = aiSummaryApi?.buildFullExportAiSummary?.({
                exportMeta: { generatedAt, timeZone: "Asia/Tokyo", profile: "full",
                    appVersion: options.appVersion || null, readOnly: true },
                compactSummary, sections, warnings
            }) || unavailable("ai_summary_builder_unavailable", "optionmap-full-export",
                { status: "not_applicable", reason: "index_only" });
            sections.aiSummary = aiSummary;
            return fullExportApi.buildFullExport({ exportMeta: { generatedAt,
                timeZone: "Asia/Tokyo", profile: "full",
                appVersion: options.appVersion || null, readOnly: true },
            compactSummary, sections, warnings });
        }
        return Object.freeze({ collect });
    }

    return Object.freeze({ createFullExportCollector });
});
