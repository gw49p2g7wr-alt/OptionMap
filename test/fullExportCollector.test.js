const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fullExport = require("../js/fullExport.js");
const { createFullExportCollector } = require("../js/fullExportCollector.js");
const { contractsMatch } = require("../js/storage/currentPriceLastValidStore.js");

const qriVersion = "qri-options-v2|2026-09|page|sha256:qri-signature";
const weeklyPrevious = "weekly-futures-v2|2026-08-21|sha256:weekly-old";
const weeklyCurrent = "weekly-futures-v2|2026-08-28|sha256:weekly-new";
const weeklyOptionCurrent = "weekly-options-v2|2026-08-28|sha256:option-new";

function qriHistory(overrides = {}) {
    const revision = {
        versionKey: qriVersion, signature: "qri-signature", contract: "2026-09",
        tradingDate: "2026-09-07", snapshotDate: "2026-09-05",
        pageUpdatedAt: "2026-09-05T18:45:00+09:00",
        fetchedAt: "2026-09-05T09:45:30.000Z", confirmedAt: "2026-09-05T09:46:00.000Z",
        replacedAt: null, openInterestStatus: "available",
        canonical: { contract: "2026-09", tradingDate: "2026-09-07",
            pageUpdatedAt: "2026-09-05T18:45:00+09:00", openInterestStatus: "available",
            records: [{ contract: "2026-09", optionType: "call", strike: 42500,
                published: true, value: 1200 }, { contract: "2026-09", optionType: "put",
                strike: 41750, published: false, value: null }] },
        ...overrides
    };
    return { entries: [{ entryKey: "2026-09|2026-09-07", contract: "2026-09",
        sourceDateKey: "2026-09-07", activeVersionKey: revision.versionKey,
        revisions: [revision] }] };
}

function dependencies(overrides = {}) {
    const qriComparison = {
        source: "formal_qri_options_history", available: true, status: "comparable",
        reason: null, contract: "2026-09", previousSourceDate: "2026-09-04",
        currentSourceDate: "2026-09-07", previousVersionKey: "qri-old",
        currentVersionKey: qriVersion, previousPageUpdatedAt: "2026-09-04T18:45:00+09:00",
        currentPageUpdatedAt: "2026-09-05T18:45:00+09:00",
        comparison: { byType: { call: { summary: { netDelta: 200,
            topIncreases: [{ strike: 42500, delta: 200 }], topDecreases: [],
            newlyPublished: [], noLongerPublished: [] } }, put: { summary: { netDelta: -50,
            topIncreases: [], topDecreases: [{ strike: 41750, delta: -50 }],
            newlyPublished: [], noLongerPublished: [] } } }, records: [] }
    };
    const weeklyVersions = [
        { sourceDate: "2026-08-21", versionKey: weeklyPrevious, signature: "weekly-old",
            listingUpdatedAt: "2026-08-21T16:00:00+09:00", savedAt: "2026-08-21T08:00:00Z",
            futureOpenInterest: { records: [{ broker: "A", value: 10 }] } },
        { sourceDate: "2026-08-28", versionKey: weeklyCurrent, signature: "weekly-new",
            listingUpdatedAt: "2026-08-28T16:00:00+09:00", savedAt: "2026-08-28T08:00:00Z",
            futureOpenInterest: { records: [{ broker: "A", value: 12 }] } }
    ];
    const weeklyOptionsHistory = { entries: [{ sourceDate: "2026-08-21",
        activeVersionKey: "weekly-options-old", revisions: [{ versionKey: "weekly-options-old",
            signature: "option-old", fetchedAt: "2026-08-21T07:00:00Z",
            confirmedAt: "2026-08-21T08:00:00Z", replacedAt: null,
            canonical: { records: [{ rank: 1, value: 9 }] } }] },
    { sourceDate: "2026-08-28", activeVersionKey: weeklyOptionCurrent,
        revisions: [{ versionKey: "inactive", signature: "inactive", replacedAt: "2026-08-28T08:00:00Z",
            canonical: { records: [{ rank: 9, value: 999 }] } },
        { versionKey: weeklyOptionCurrent, signature: "option-new",
            fetchedAt: "2026-08-28T07:00:00Z", confirmedAt: "2026-08-28T08:00:00Z",
            replacedAt: null, canonical: { optionExpiries: { call: "2026-09", put: "2026-09" },
                records: [{ optionType: "call", expiry: "2026-09", strike: 42500,
                    rank: 1, participantCode: "1001", broker: "Broker A", side: "buy",
                    published: true, value: 20 }] } }] }] };
    return {
        now: () => "2026-09-06T07:15:00+09:00",
        getSectionFreshness: () => ({ status: "fresh", reason: "current_session" }),
        contractsMatch,
        getMobileSummary: () => ({ marketDate: "2026-09-07",
            payload: { currentPrice: { available: true, status: "available", value: 42125,
                source: "qri-nikkei225-futures", mode: "automatic", contract: "2026-09",
                quotedAt: "2026-09-05T18:44:00+09:00", fetchedAt: "2026-09-05T09:45:00Z" },
            nearestLevels: { upper: { available: true, price: 42500, optionType: "CALL" },
                lower: { available: true, price: 41750, optionType: "PUT" } } },
            freshness: { currentPriceAt: "2026-09-05T18:44:00+09:00",
                qriAt: "2026-09-05T18:45:00+09:00", weeklyFuturesAt: "2026-08-28T08:00:00Z",
                weeklyOptionsAt: "2026-08-28T08:00:00Z", participantAt: "2026-09-04T08:00:00Z" },
            warnings: [] }),
        getMarketSession: () => ({ status: "verified", calendarDate: "2026-09-06",
            tradingDate: "2026-09-07" }),
        getCurrentPriceIdentity: () => ({ status: "available", fact: { available: true,
            sourceKind: "live", origin: "live", mode: "automatic", identityVerified: true,
            acquisitionVerified: true, currentRequestVerified: true, contract: "2026-09",
            value: 42125, quotedAtRaw: "09/05 18:44",
            quotedAtNormalized: "2026-09-05T18:44:00+09:00",
            quoteSignature: "price-quote-signature", versionKey: "price-version-key",
            wrapperSignature: "price-wrapper-signature",
            requestId: "qri-price-request-1", fetchedAt: "2026-09-05T09:45:00Z",
            sourceUrl: "https://svc.qri.jp/jpx/nkopm/202609",
            quoteIdentity: { value: 42125, contract: "2026-09",
                quotedAtRaw: "09/05 18:44",
                quotedAtNormalized: "2026-09-05T18:44:00+09:00",
                quoteSignature: "price-quote-signature", versionKey: "price-version-key" },
            acquisitionIdentity: { requestId: "qri-price-request-1",
                fetchedAt: "2026-09-05T09:45:00Z",
                sourceUrl: "https://svc.qri.jp/jpx/nkopm/202609",
                wrapperSignature: "price-wrapper-signature" },
            qriTradingDateMapping: { mappingVerified: true,
                mappingSource: "same_date_explicit" } } }),
        getOverallV2FormalEnvelope: () => ({ status: "available", envelope: {
            formalApplied: true, identityVerified: true, logicVersion: "overall-v2-weights-55-45-v1",
            evaluatedAt: "2026-09-05T09:46:10Z", inputFingerprint: "overall-fingerprint",
            result: { status: "complete", direction: 24, directionLabel: "買い優勢",
                confidence: 81, confidenceFactors: { coverage: 100, quality: 90,
                    evidence: 75, agreement: 80 }, metadata: { coverage: 100, warnings: [] },
                components: { option: { available: true, directionScore: 30, qualityFactor: 1,
                    evidenceFactor: 0.8, effectiveWeight: 55, weightedContribution: 16.5, notes: [] },
                weekly: { available: true, directionScore: 17, qualityFactor: 1,
                    evidenceFactor: 0.7, effectiveWeight: 45, weightedContribution: 7.65, notes: [] } } }
        } }),
        getMorningRestoreState: () => ({ restoreStatus: "valid", integrityStatus: "valid",
            applicabilityStatus: "applicable", selectedBaselineId: "baseline-1",
            diagnostics: { selectedActiveRevision: true, baselineValidated: true },
            baseline: { capturedAt: "2026-09-05T22:50:00Z" } }),
        getMorningComparisonState: () => ({ status: "available", available: true,
            formalTradingDate: "2026-09-07", contract: "2026-09", selectedBaselineId: "baseline-1",
            comparison: { status: "comparable", available: true,
                divergence: { priceDelta: 125, supplyDemandDelta: 8, relation: "same_direction" },
                dataQuality: { transition: "unchanged" }, comparability: { contractContext: {
                    qriContract: "2026-11", futuresContract: "2026-12",
                    relation: "independent_cross_contract",
                    relationAuthority: "verified_nikkei225_option_and_futures_identities" } } } }),
        getQriFormalIdentity: () => ({ status: "available", fact: {
            sourceClass: "formal_live", origin: "live", identityVerified: true,
            acquisitionVerified: true, usingFallback: false, referenceOnly: false,
            contract: "2026-09", tradingDate: "2026-09-07",
            pageUpdatedAt: "2026-09-05T18:45:00+09:00",
            canonicalVersionKey: qriVersion, canonicalSignature: "qri-signature",
            fetchedAt: "2026-09-05T09:45:30.000Z" } }),
        readQriHistory: async () => ({ status: "ready", history: qriHistory() }),
        validateQriHistory: async () => ({ valid: true, errors: [] }),
        compareQriHistory: async () => qriComparison,
        getWeeklyFormalIdentity: () => ({ status: "available", fact: {
            sourceClass: "formal_history", previousVersionKey: weeklyPrevious,
            currentVersionKey: weeklyCurrent, currentSignature: "weekly-new",
            sourceDate: "2026-08-28", activeVersionMatched: true,
            dataStatus: "formal_history", origin: "weekly_futures_history",
            sourceFingerprint: "weekly-fingerprint" } }),
        readWeeklyFuturesActiveVersions: async () => weeklyVersions,
        getWeeklyCandidate: () => ({ available: true,
            judgment: { direction: "買い優勢", buyScore: 0.2, sellScore: 0.1,
                scoreDiff: 0.1, eligibleBrokerCount: 5, requiredBrokerCount: 5 },
            metadata: { previous: { versionKey: weeklyPrevious },
                current: { versionKey: weeklyCurrent }, activeVersionMatched: true } }),
        getTwelveGroup: () => ({ status: "available", pairIdentity: {
            previous: { versionKey: weeklyPrevious }, current: { versionKey: weeklyCurrent } },
            major5: { available: true, direction: "買い優勢" },
            groups12: { available: true, availableGroupCount: 12, requiredGroupCount: 12,
                missingGroups: [], direction: "buy", groups: [] },
            comparison: { available: true, agreement: "same_direction" } }),
        readWeeklyOptionsHistory: async () => ({ status: "ready", history: weeklyOptionsHistory }),
        validateWeeklyOptionsHistory: async () => ({ valid: true, errors: [] }),
        compareWeeklyOptionsHistory: async () => ({ source: "formal_weekly_options_history",
            available: true, status: "comparable", reason: null,
            previousSourceDate: "2026-08-21", currentSourceDate: "2026-08-28",
            previousVersionKey: "weekly-options-old", currentVersionKey: weeklyOptionCurrent,
            changes: { strikeChanges: [{ strike: 42500, delta: 3 }] }, counts: { comparable: 1 } }),
        readParticipants: async () => ({ status: "partial", reason: "night_jnet_unavailable",
            sourceDate: "2026-09-04", fetchedAt: "2026-09-04T08:00:00Z", origin: "live",
            versionKey: null, signature: null,
            fileStatuses: { dayAuction: "success", dayJnet: "success",
                nightAuction: "success", nightJnet: "unavailable" },
            records: [{ product: "NK225F", contractCode: "2026-09", rank: 1,
                participantCode: "1001", company: "Broker A", volume: 100 }] }),
        validateParticipants: async source => source?.status === "partial" ||
            source?.status === "available",
        readIntelligenceSnapshots: async () => [{ sourceDate: "2026-09-01T00:00:00Z",
            savedAt: "2026-09-01T01:00:00Z", memo: "private memo", tags: ["private"],
            nightData: "raw" }, { sourceDate: "2026-09-05T00:00:00Z",
            savedAt: "2026-09-05T01:00:00Z", optionData: "raw" }],
        ...overrides
    };
}

async function collect(overrides = {}) {
    return createFullExportCollector(dependencies(overrides)).collect({
        appVersion: "1.1.0-beta.2", platform: "win32", market: "Nikkei 225 derivatives"
    });
}

test("全section available/partial fixtureからvalid Full Exportを構築", async () => {
    const result = await collect();
    assert.equal(fullExport.validateFullExport(result).valid, true);
    assert.deepEqual(Object.keys(result.sections),
        [...fullExport.REQUIRED_SECTION_KEYS, "aiSummary", "changeSummary", "consumerReadiness",
            "morningV5Formal", "qriOptionIv"]);
    assert.equal(result.sections.participants.status, "partial");
    assert.equal(result.sections.aiSummary.status, "available");
    assert.equal(result.sections.aiSummary.authority.sourceClass, "derived_index");
    assert.equal(result.sections.aiSummary.summary.purpose,
        "index_only_not_authoritative_data");
    assert.equal(result.sections.aiSummary.summary.overallV2.direction,
        result.sections.overallV2.summary.direction);
    assert.equal(result.sections.aiSummary.summary.qriContracts.active.contract,
        result.sections.qriOptions.summary.contract);
    assert.equal(result.sections.aiSummary.summary.qriContracts.next.contract,
        result.sections.qriOptionsNextContract.summary?.contract || null);
    assert.equal(result.sections.aiSummary.summary.qriContracts.majorSq.contract,
        result.sections.qriOptionsMajorSqNextContract.summary?.contract || null);
    assert.equal(result.sections.qriOptionIv.status, "unavailable");
    assert.equal(result.sections.aiSummary.summary.qriOptionIv.sourcePointer,
        "/sections/qriOptionIv");
    assert.equal(result.sections.consumerReadiness.status, "available");
    assert.equal(result.sections.consumerReadiness.summary.authoritativeRoot, "/sections");
    assert.equal(result.sections.changeSummary.status, "available");
    assert.equal(result.sections.changeSummary.authority.formalStatus, "derived");
    assert.equal(result.sections.changeSummary.summary.comparisonVocabularyVersion, 1);
    assert.equal(result.sections.aiSummary.summary.changeSummary.sourcePointer,
        "/sections/changeSummary");
    assert.deepEqual(result.sections.aiSummary.summary.consumerReadiness, {
        sourceSection: "consumerReadiness", sourcePointer: "/sections/consumerReadiness",
        status: "available", reason: null, vocabularyVersion: 1,
        authoritativeRoot: "/sections"
    });
    assert.equal(JSON.stringify(result.compactSummary).includes("qriOptionIv"), false);
    assert.equal(result.compactSummary.freshnessIssues.some(issue =>
        issue.section === "qriOptionIv"), false);
});

test("production形状のsourceなしlive current-price factを正常受理", async () => {
    const deps = dependencies();
    const fact = deps.getCurrentPriceIdentity().fact;
    assert.equal(Object.hasOwn(fact, "source"), false);
    const result = await awaitFullExport(deps);
    assert.equal(result.sections.marketSnapshot.status, "available");
    assert.equal(result.sections.marketSnapshot.authority.sourceClass, "formal_live");
});

test("current-price fact内部のcontract不一致とacquisition未検証はunavailable", async () => {
    for (const patch of [{ contract: "2026-12" }, { contract: null },
        { acquisitionVerified: false }, { sourceUrl: "https://example.invalid/futures" }]) {
        const deps = dependencies(); const state = deps.getCurrentPriceIdentity();
        deps.getCurrentPriceIdentity = () => ({ ...state, fact: { ...state.fact, ...patch } });
        const result = await awaitFullExport(deps);
        assert.equal(result.sections.marketSnapshot.reason, "current_price_identity_mismatch");
    }
});

test("stale reference freshness never promotes an automatic marketSnapshot", async () => {
    const result = await collect({ getSectionFreshness: name => name === "marketSnapshot"
        ? { status: "stale", reason: "stale_reference", displayEligible: true,
            calculationEligible: "ineligible" }
        : { status: "fresh", reason: "current" } });
    assert.equal(result.sections.marketSnapshot.status, "unavailable");
    assert.equal(result.sections.marketSnapshot.reason, "current_price_stale_reference");
    assert.equal(result.sections.marketSnapshot.freshness.status, "stale");
});

test("stale Mobile投影を使わずQRI option限月とfresh Futures限月を独立昇格", async () => {
    const deps = dependencies();
    const state = deps.getCurrentPriceIdentity();
    deps.getCurrentPriceIdentity = () => ({ ...state, fact: { ...state.fact,
        value: 66480, contract: "2026-12", quotedAtRaw: "10/15 06:00",
        quotedAtNormalized: "2026-10-15T06:00:00+09:00",
        fetchedAt: "2026-10-15T06:01:00+09:00",
        sourceUrl: "https://svc.qri.jp/jpx/nkopm/202611",
        requestId: "qri-price-request-2", quoteIdentity: { ...state.fact.quoteIdentity,
            value: 66480, contract: "2026-12", quotedAtRaw: "10/15 06:00",
            quotedAtNormalized: "2026-10-15T06:00:00+09:00" },
        acquisitionIdentity: { ...state.fact.acquisitionIdentity,
            requestId: "qri-price-request-2", fetchedAt: "2026-10-15T06:01:00+09:00",
            sourceUrl: "https://svc.qri.jp/jpx/nkopm/202611" } } });
    const result = await awaitFullExport(deps);
    assert.equal(result.sections.marketSnapshot.status, "available");
    assert.equal(result.sections.marketSnapshot.summary.value, 66480);
    assert.equal(result.sections.marketSnapshot.summary.contract, "2026-12");
    assert.equal(result.sections.qriOptions.summary.contract, "2026-09");
});

test("verified live factがあればMobile currentPrice欠落でもmarketSnapshotを昇格", async () => {
    const deps = dependencies(); const mobile = deps.getMobileSummary();
    deps.getMobileSummary = () => ({ ...mobile, payload: { ...mobile.payload,
        currentPrice: { available: false, status: "unavailable" } } });
    const result = await awaitFullExport(deps);
    assert.equal(result.sections.marketSnapshot.status, "available");
    assert.equal(result.sections.marketSnapshot.summary.contract, "2026-09");
});

test("saved/cache/reference current-price factへfallbackしない", async () => {
    for (const patch of [{ sourceKind: "saved", origin: "saved" },
        { sourceKind: "cache", origin: "cache" }, { sourceKind: "reference", origin: "reference" }]) {
        const deps = dependencies(); const state = deps.getCurrentPriceIdentity();
        deps.getCurrentPriceIdentity = () => ({ ...state, fact: { ...state.fact, ...patch } });
        const result = await awaitFullExport(deps);
        assert.equal(result.sections.marketSnapshot.status, "unavailable");
    }
});

test("実機相当weekend cross-date factをruntime authorityどおりavailableで保持", async () => {
    const deps = dependencies(); const state = deps.getCurrentPriceIdentity();
    const mobile = deps.getMobileSummary();
    deps.getMobileSummary = () => ({ ...mobile, payload: { ...mobile.payload,
        currentPrice: { ...mobile.payload.currentPrice, contract: "26年09月限" } } });
    deps.getCurrentPriceIdentity = () => ({ ...state, fact: { ...state.fact,
        reason: "date_context_unresolved", qriTradingDateMapping: { mappingVerified: false,
            mappingSource: null, relation: "previous_date", quoteDate: "2026-09-05",
            qriTradingDate: "2026-09-07", status: "date_context_unresolved" } } });
    const result = await awaitFullExport(deps);
    assert.equal(result.sections.marketSnapshot.status, "available");
    assert.equal(result.sections.marketSnapshot.authority.formalStatus, "verified");
    assert.deepEqual(result.sections.marketSnapshot.details.identity.qriTradingDateMapping,
        { mappingVerified: false, mappingSource: null, relation: "previous_date",
            quoteDate: "2026-09-05", qriTradingDate: "2026-09-07",
            status: "date_context_unresolved" });
});

test("既存contractsMatchはcanonical/display表記を一致させ異なる限月を拒否", () => {
    assert.equal(contractsMatch("26年09月限", "2026-09"), true);
    assert.equal(contractsMatch("26年12月限", "2026-09"), false);
});

test("contractsMatch helperが利用不可ならautomaticを推測でavailableにしない", async () => {
    const result = await collect({ contractsMatch: undefined });
    assert.equal(result.sections.marketSnapshot.status, "unavailable");
    assert.equal(result.sections.marketSnapshot.reason, "current_price_identity_mismatch");
});

test("runtime unavailableとMobile Summary単独表示はFormalへ昇格しない", async () => {
    for (const getCurrentPriceIdentity of [() => ({ status: "unavailable", fact: null }),
        () => null]) {
        const result = await collect({ getCurrentPriceIdentity });
        assert.equal(result.sections.marketSnapshot.status, "unavailable");
    }
});

test("current-price identity/currentRequest未検証はunavailable", async () => {
    for (const patch of [{ identityVerified: false }, { currentRequestVerified: false }]) {
        const deps = dependencies(); const state = deps.getCurrentPriceIdentity();
        deps.getCurrentPriceIdentity = () => ({ ...state, fact: { ...state.fact, ...patch } });
        const result = await awaitFullExport(deps);
        assert.equal(result.sections.marketSnapshot.status, "unavailable");
    }
});

test("manual modeの既存user_input分岐は不変", async () => {
    const deps = dependencies(); const mobile = deps.getMobileSummary();
    deps.getMobileSummary = () => ({ ...mobile, payload: { ...mobile.payload,
        currentPrice: { ...mobile.payload.currentPrice, value: 43001,
            mode: "manual", source: "manual" } } });
    const result = await awaitFullExport(deps);
    assert.equal(result.sections.marketSnapshot.status, "available");
    assert.equal(result.sections.marketSnapshot.authority.sourceClass, "user_input");
    assert.equal(result.sections.marketSnapshot.summary.value, 43001);
});

test("collectorは独自contract normalizerを持たない", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/fullExportCollector.js"), "utf8");
    assert.doesNotMatch(source, /canonicalContract|normalizeContract|年\\s\*\\d|月限/);
    assert.match(source, /configuration\.contractsMatch/);
});

test("QRI formal versionKey不一致はfallbackせずunavailable", async () => {
    const result = await collect({ readQriHistory: async () => ({ status: "ready",
        history: qriHistory({ versionKey: "different" }) }) });
    assert.equal(result.sections.qriOptions.status, "unavailable");
    assert.equal(result.sections.qriOptions.reason, "formal_revision_not_found");
    assert.equal(result.sections.qriOptions.details, null);
});

test("QRI signature不一致はunavailable", async () => {
    const result = await collect({ readQriHistory: async () => ({ status: "ready",
        history: qriHistory({ signature: "different" }) }) });
    assert.equal(result.sections.qriOptions.reason, "formal_identity_mismatch");
});

test("QRI tradingDate/snapshotDate/pageUpdatedAtを独立保持", async () => {
    const result = await collect();
    assert.deepEqual(result.sections.qriOptions.asOf, { tradingDate: "2026-09-07",
        sourceDate: "2026-09-07", snapshotDate: "2026-09-05",
        pageUpdatedAt: "2026-09-05T18:45:00+09:00",
        fetchedAt: "2026-09-05T09:45:30.000Z", confirmedAt: "2026-09-05T09:46:00.000Z" });
});

test("QRI非掲載値を0補完しない", async () => {
    const result = await collect();
    const put = result.sections.qriOptions.details.records.find(item => item.optionType === "put");
    assert.equal(put.published, false);
    assert.equal(put.value, null);
});

test("OverallV2 formal resultを不変転記し独自scoreを追加しない", async () => {
    const deps = dependencies(); const source = deps.getOverallV2FormalEnvelope();
    const result = await createFullExportCollector(deps).collect({ appVersion: "1", market: "Nikkei" });
    assert.deepEqual(result.sections.overallV2.details.result, source.envelope.result);
    assert.equal("tradeSignal" in result.sections.overallV2.summary, false);
});

test("OverallV2 unavailable時にMobile Summaryの過去値へfallbackしない", async () => {
    const result = await collect({ getOverallV2FormalEnvelope: () => ({ status: "unavailable",
        reason: "source_binding_mismatch", envelope: null }) });
    assert.equal(result.sections.overallV2.status, "unavailable");
    assert.equal(result.compactSummary.overallV2.direction, null);
});

test("Morning incomparable時にdeltaを推測しない", async () => {
    const result = await collect({ getMorningComparisonState: () => ({ status: "unavailable",
        reason: "contract_roll", available: false, comparison: null }) });
    assert.equal(result.sections.morning.status, "unavailable");
    assert.equal(result.sections.morning.summary, null);
    assert.equal(result.compactSummary.morningChange.status, "unavailable");
});

test("Morning exportはQRIと先物の独立限月とrelationを保持", async () => {
    const result = await collect();
    assert.equal(result.sections.morning.status, "available");
    assert.equal(result.sections.morning.summary.qriContract, "2026-11");
    assert.equal(result.sections.morning.summary.futuresContract, "2026-12");
    assert.equal(result.sections.morning.summary.contractRelation, "independent_cross_contract");
});

test("Weekly Futures formal mismatchはunavailable", async () => {
    const result = await collect({ getWeeklyFormalIdentity: () => ({ status: "available", fact: {
        sourceClass: "formal_history", previousVersionKey: weeklyPrevious,
        currentVersionKey: "wrong", currentSignature: "wrong", sourceDate: "2026-08-28",
        activeVersionMatched: true, dataStatus: "formal_history",
        origin: "weekly_futures_history", sourceFingerprint: "weekly-fingerprint" } }) });
    assert.equal(result.sections.weeklyFutures.status, "unavailable");
    assert.equal(result.sections.weeklyFutures.reason, "formal_revision_not_found");
});

test("previousSignatureを持たない正式Weekly factと一致active revisionsを受理", async () => {
    const deps = dependencies(); const fact = deps.getWeeklyFormalIdentity().fact;
    assert.equal(Object.hasOwn(fact, "previousSignature"), false);
    const result = await awaitFullExport(deps);
    assert.equal(result.sections.weeklyFutures.status, "available");
    assert.equal(result.sections.weeklyFutures.authority.versionKey, weeklyCurrent);
});

test("Weekly current signatureまたはsourceDate不一致はunavailable", async () => {
    for (const patch of [{ currentSignature: "wrong" }, { sourceDate: "2026-08-21" }]) {
        const deps = dependencies(); const state = deps.getWeeklyFormalIdentity();
        deps.getWeeklyFormalIdentity = () => ({ ...state, fact: { ...state.fact, ...patch } });
        const result = await awaitFullExport(deps);
        assert.equal(result.sections.weeklyFutures.reason, "formal_identity_mismatch");
    }
});

test("Weekly previous/current versionKey不一致はactive以外へfallbackしない", async () => {
    for (const patch of [{ previousVersionKey: "inactive-previous" },
        { currentVersionKey: "inactive-current" }]) {
        const deps = dependencies(); const state = deps.getWeeklyFormalIdentity();
        deps.getWeeklyFormalIdentity = () => ({ ...state, fact: { ...state.fact, ...patch } });
        const result = await awaitFullExport(deps);
        assert.equal(result.sections.weeklyFutures.reason, "formal_revision_not_found");
        assert.equal(result.sections.weeklyFutures.details, null);
    }
});

test("主要5社/12-groupは既存objectを転記しcollectorで再計算しない", async () => {
    const deps = dependencies(); const major5 = deps.getWeeklyCandidate();
    const groups = deps.getTwelveGroup();
    const result = await createFullExportCollector(deps).collect({ appVersion: "1", market: "Nikkei" });
    assert.deepEqual(result.sections.weeklyFutures.summary.major5, major5.judgment);
    assert.deepEqual(result.sections.weeklyFutures.summary.twelveGroup, groups.groups12);
});

test("Weekly Optionsはactive revisionだけを出力", async () => {
    const result = await collect();
    assert.equal(result.sections.weeklyOptions.authority.versionKey, weeklyOptionCurrent);
    assert.equal(result.sections.weeklyOptions.details.records.length, 1);
    assert.equal(result.sections.weeklyOptions.details.records[0].value, 20);
});

test("Participant partial 4-file状態とrecordsを保持", async () => {
    const result = await collect();
    assert.equal(result.sections.participants.status, "partial");
    assert.equal(result.sections.participants.summary.fileStatuses.nightJnet, "unavailable");
    assert.equal(result.sections.participants.details.records[0].volume, 100);
});

test("Participant validation失敗はpartial recordsを公開しない", async () => {
    const result = await collect({ validateParticipants: async () => false });
    assert.equal(result.sections.participants.status, "invalid");
    assert.equal(result.sections.participants.reason, "participant_validation_failed");
    assert.equal(result.sections.participants.details, null);
});

test("freshness statusをそのまま保持", async () => {
    const result = await collect({ getSectionFreshness: name => name === "qriOptions"
        ? { status: "stale", reason: "source_not_updated" }
        : { status: "fresh", reason: "current" } });
    assert.deepEqual(result.sections.qriOptions.freshness,
        { status: "stale", reason: "source_not_updated" });
    assert.deepEqual(result.compactSummary.freshnessIssues,
        [{ section: "qriOptions", status: "stale", reason: "source_not_updated" },
        { section: "qriOptionsNextContract", status: "unavailable",
            reason: "section_unavailable" },
        { section: "qriOptionsMajorSqNextContract", status: "unavailable",
            reason: "section_unavailable" },
        { section: "morningV5Formal", status: "unavailable",
            reason: "formal_observation_not_saved" }]);
});

test("compact freshness issue preserves consumer provenance without recomputation", async () => {
    const provenance = { status: "stale", reason: "date_unverifiable", origin: "live",
        dataTradingDate: "2026-09-07", expectedTradingDate: null,
        expectedTradingDateSource: "formal_calendar_history_readonly",
        payloadValidation: "valid", dateRelation: "unverifiable",
        consumerState: "valid_date_unverifiable", staleReason: "expected_trading_date_unknown" };
    const result = await collect({ getSectionFreshness: name => name === "qriOptions"
        ? provenance : { status: "fresh", reason: "current" } });
    const issue = result.compactSummary.freshnessIssues.find(value =>
        value.section === "qriOptions");
    assert.deepEqual(issue, { section: "qriOptions", ...provenance });
    const aiIssue = result.sections.aiSummary.summary.dataQuality.affectedSections.find(value =>
        value.section === "qriOptions" && value.issueType === "freshness");
    assert.deepEqual([aiIssue.payloadValidation, aiIssue.consumerState,
        aiIssue.expectedTradingDateSource], ["valid", "valid_date_unverifiable",
        "formal_calendar_history_readonly"]);
});

test("unavailable sectionは提供freshnessがfreshでも昇格させない", async () => {
    const result = await collect({
        getCurrentPriceIdentity: () => ({ status: "unavailable", fact: null }),
        getSectionFreshness: () => ({ status: "fresh", reason: "current" })
    });
    assert.equal(result.sections.marketSnapshot.status, "unavailable");
    assert.deepEqual(result.sections.marketSnapshot.freshness,
        { status: "unavailable", reason: "section_unavailable" });
});

test("Intelligenceは集計値だけでmemo/tags/raw inputを出力しない", async () => {
    const result = await collect(); const text = JSON.stringify(result.sections.intelligence);
    assert.deepEqual(result.sections.intelligence.summary, { snapshotCount: 2,
        distinctDayCount: 2, firstSnapshotAt: "2026-09-01T00:00:00Z",
        latestSnapshotAt: "2026-09-05T00:00:00Z" });
    assert.doesNotMatch(text, /memo|tags|nightData|optionData|private|raw/);
});

test("collector中にstorage write/fetch/runtime publishを呼ばない", async () => {
    const calls = { setItem: 0, put: 0, add: 0, delete: 0, fetch: 0, publish: 0 };
    const deps = dependencies({
        storage: Object.fromEntries(Object.keys(calls).map(key => [key, () => { calls[key] += 1; }])),
        fetch: () => { calls.fetch += 1; },
        publish: () => { calls.publish += 1; }
    });
    await awaitFullExport(deps);
    assert.deepEqual(calls, { setItem: 0, put: 0, add: 0, delete: 0, fetch: 0, publish: 0 });
});

async function awaitFullExport(deps) {
    return createFullExportCollector(deps).collect({ appVersion: "1", market: "Nikkei" });
}

test("input/runtime objectをmutateしない", async () => {
    const deps = dependencies();
    const mobile = deps.getMobileSummary();
    deps.getMobileSummary = () => mobile;
    const before = structuredClone(mobile);
    await awaitFullExport(deps);
    assert.deepEqual(mobile, before);
});

test("history/cache/snapshot inputをrepair・変更しない", async () => {
    const deps = dependencies();
    const qri = qriHistory();
    const weeklyOptions = await deps.readWeeklyOptionsHistory();
    const participants = await deps.readParticipants();
    const intelligence = await deps.readIntelligenceSnapshots();
    deps.readQriHistory = async () => ({ status: "ready", history: qri });
    deps.readWeeklyOptionsHistory = async () => weeklyOptions;
    deps.readParticipants = async () => participants;
    deps.readIntelligenceSnapshots = async () => intelligence;
    const before = structuredClone({ qri, weeklyOptions, participants, intelligence });
    await awaitFullExport(deps);
    assert.deepEqual({ qri, weeklyOptions, participants, intelligence }, before);
});

test("source moduleはruntime global/storage/network/UIへ接続しない", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/fullExportCollector.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|\bfetch\s*\(|document\.|\.publish\s*\(|setItem|\.put\s*\(|\.add\s*\(|\.delete\s*\(/);
});

test("reader例外でも全必須sectionを保持してsecurity validatorを通る", async () => {
    const result = await collect({ readParticipants: async () => { throw new Error("read failed"); } });
    assert.equal(result.sections.participants.status, "unavailable");
    assert.equal(result.sections.participants.reason, "participant_read_failed");
    assert.deepEqual(Object.keys(result.sections),
        [...fullExport.REQUIRED_SECTION_KEYS, "aiSummary", "changeSummary", "consumerReadiness",
            "morningV5Formal", "qriOptionIv"]);
    assert.equal(fullExport.validateFullExport(result).valid, true);
});
