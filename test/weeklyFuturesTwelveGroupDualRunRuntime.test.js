const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const weekly = require("../js/weeklyFutures.js");
const brokerConfig = require("../js/weeklyBrokerConfig.js");
const shadow = require("../js/weeklyFuturesTwelveGroupShadow.js");
const adapter = require(
    "../js/weeklyFuturesTwelveGroupFormalPairAdapter.js"
);
const Runtime = require(
    "../js/weeklyFuturesTwelveGroupDualRunRuntime.js"
);

const PARTICIPANTS = [
    ...brokerConfig.PARTICIPANTS,
    shadow.ADDITIONAL_PARTICIPANTS.SG,
    shadow.ADDITIONAL_PARTICIPANTS.MORGAN_MUFG,
    shadow.ADDITIONAL_PARTICIPANTS.SBI,
    shadow.ADDITIONAL_PARTICIPANTS.RAKUTEN,
    shadow.ADDITIONAL_PARTICIPANTS.MITSUBISHI_UFJ,
    shadow.ADDITIONAL_PARTICIPANTS.DAIWA,
    shadow.ADDITIONAL_PARTICIPANTS.CITI,
    shadow.ADDITIONAL_PARTICIPANTS.BARCLAYS
];

function data(values = {}, omitted = [], names = {}) {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...PARTICIPANTS.filter(item => !omitted.includes(item.key)).map(item => [
            "1", "2026年09月限月", null, null, null,
            item.participantCode, names[item.key] || item.brokerName,
            values[item.key] ?? 100
        ])
    ]);
}

function revision(sourceDate, canonicalData) {
    const normalized = weekly.normalizeForSignature(canonicalData);
    const signature = crypto.createHash("sha256")
        .update(JSON.stringify(normalized)).digest("hex");
    const versionKey = `weekly-futures-v2|${sourceDate}|sha256:${signature}`;
    return { sourceDate, versionKey, signature,
        activeVersionKey: versionKey, canonicalData };
}

function publication(options = {}) {
    const previous = revision("2026-08-07", options.previous || data());
    const current = revision("2026-08-14", options.current || data());
    const requestId = options.requestId || "weekly-request-8";
    const sourceFingerprint = options.sourceFingerprint || "weekly-source-8";
    const generation = options.generation || 8;
    const pair = {
        previous,
        current,
        formalContext: {
            sourceClass: "formal_history",
            activeVersionMatched: true,
            requestId,
            generation,
            generationFingerprint: sourceFingerprint
        }
    };
    const pairIdentity = Runtime.pairIdentity(pair);
    const majorNormalized = options.majorNormalized ?? 0.4;
    return {
        formalPair: pair,
        major5: {
            formalApplied: true,
            available: options.majorAvailable !== false,
            direction: options.majorDirection || "買い優勢",
            normalizedDirection: majorNormalized,
            qualityFactor: 1,
            eligibleBrokerCount: 5,
            requiredBrokerCount: 5,
            pairIdentity,
            requestId,
            sourceFingerprint
        },
        weeklyFormalIdentity: {
            status: "available",
            publicationGeneration: generation,
            fact: {
                sourceClass: "formal_history",
                sourceDate: current.sourceDate,
                previousVersionKey: previous.versionKey,
                currentVersionKey: current.versionKey,
                currentSignature: current.signature,
                activeVersionMatched: true,
                requestId,
                sourceFingerprint,
                componentMetadata: {
                    previous: {
                        sourceDate: previous.sourceDate,
                        versionKey: previous.versionKey,
                        signature: previous.signature
                    },
                    current: {
                        sourceDate: current.sourceDate,
                        versionKey: current.versionKey,
                        signature: current.signature
                    }
                }
            }
        }
    };
}

const current = () => true;

test("valid same-pairでMajor5 formalと12-group shadowを公開する", async () => {
    const runtime = Runtime.createRuntime({ now: () => "2026-08-27T01:00:00Z" });
    const result = await runtime.publish(publication({
        current: data({ SG: 125 })
    }), { isCurrentPublication: current });
    const state = runtime.getState();
    assert.deepEqual(result, { published: true, status: "available",
        generation: 1 });
    assert.equal(state.publishedAt, "2026-08-27T01:00:00Z");
    assert.equal(state.major5.formal, true);
    assert.equal(state.major5.available, true);
    assert.equal(state.groups12.available, true);
    assert.equal(state.diagnostics.samePairVerified, true);
});

test("adapterの12 group factsをconfig順・同一identityでclone公開する", async () => {
    const runtime = Runtime.createRuntime();
    const input = publication({ current: data({
        SG: 125, SBI: 110, RAKUTEN: 130
    }, ["MITSUBISHI_UFJ"]) });
    await runtime.publish(input, { isCurrentPublication: current });
    const state = runtime.getState();
    assert.deepEqual(Object.keys(state.groups12.groups), [
        "JPM", "GS", "NOMURA", "BNP", "ABN", "SG", "MORGAN_MUFG",
        "SBI_RAKUTEN", "MITSUBISHI_UFJ", "DAIWA", "CITI", "BARCLAYS"
    ]);
    assert.equal(state.groups12.groups.SG.status, "estimatedBuy");
    assert.ok(state.groups12.groups.SG.contribution > 0);
    assert.equal(state.groups12.groups.JPM.contribution, 0);
    assert.equal(state.groups12.groups.MITSUBISHI_UFJ.availability, false);
    assert.equal(state.groups12.groups.MITSUBISHI_UFJ.contribution, null);
    assert.equal(state.groups12.groups.MITSUBISHI_UFJ.reason,
        "unpublished_expiry");
    assert.equal(state.groups12.groups.SBI_RAKUTEN.composite, true);
    assert.equal(state.groups12.groups.SBI_RAKUTEN.members.length, 2);
    assert.equal(state.groups12.groups.SBI_RAKUTEN.contribution, 0.2);
    assert.deepEqual(state.pairIdentity, Runtime.pairIdentity(input.formalPair));
    assert.equal(state.requestId, input.major5.requestId);
    assert.equal(state.weeklyPublicationGeneration,
        input.weeklyFormalIdentity.publicationGeneration);
    assert.equal(state.sourceFingerprint, input.major5.sourceFingerprint);
    assert.equal(state.configIdentity.configVersion,
        adapter.CONFIG_VERSION);
});

test("negative contributionをruntime taxonomyのまま保持する", async () => {
    const runtime = Runtime.createRuntime({
        adaptFormalPair: async pair => {
            const adapted = structuredClone(await adapter.adaptFormalPair(pair));
            adapted.result.groups.SG.status = "estimatedSell";
            adapted.result.groups.SG.contribution = -0.25;
            return adapted;
        }
    });
    await runtime.publish(publication(), { isCurrentPublication: current });
    const group = runtime.getState().groups12.groups.SG;
    assert.equal(group.status, "estimatedSell");
    assert.equal(group.contribution, -0.25);
});

for (const [name, mutate, reason] of [
    ["previous version mismatch", value => {
        value.major5.pairIdentity.previous.versionKey = "different";
    }, "major5_pair_mismatch"],
    ["current version mismatch", value => {
        value.major5.pairIdentity.current.versionKey = "different";
    }, "major5_pair_mismatch"],
    ["previous signature mismatch", value => {
        value.major5.pairIdentity.previous.signature = "different";
    }, "major5_pair_mismatch"],
    ["current signature mismatch", value => {
        value.weeklyFormalIdentity.fact.currentSignature = "different";
    }, "weekly_pair_mismatch"],
    ["active revision mismatch", value => {
        value.formalPair.formalContext.activeVersionMatched = false;
    }, "active_revision_mismatch"],
    ["request mismatch", value => {
        value.major5.requestId = "different";
    }, "request_mismatch"],
    ["generation mismatch", value => {
        value.formalPair.formalContext.generation = 7;
    }, "generation_mismatch"],
    ["source fingerprint mismatch", value => {
        value.major5.sourceFingerprint = "different";
    }, "source_fingerprint_mismatch"],
    ["Major5 unavailable", value => {
        value.major5.available = false;
    }, "major5_unavailable"]
]) {
    test(`${name}はdual-run unavailable`, async () => {
        const runtime = Runtime.createRuntime();
        const value = publication();
        mutate(value);
        const result = await runtime.publish(value,
            { isCurrentPublication: current });
        assert.equal(result.status, "unavailable");
        assert.equal(result.reason, reason);
        assert.equal(runtime.getState().comparison, null);
    });
}

test("12/12・11/12・10/12とcore missingを既存結果から保持する", async () => {
    const cases = [
        [[], "full", true],
        [["MITSUBISHI_UFJ"], "partial_one_missing", true],
        [["MITSUBISHI_UFJ", "CITI"], "partial_two_missing", true],
        [["JPM"], "unavailable", false]
    ];
    for (const [omitted, quality, available] of cases) {
        const runtime = Runtime.createRuntime();
        await runtime.publish(publication({ current: data({}, omitted) }),
            { isCurrentPublication: current });
        const state = runtime.getState();
        assert.equal(state.groups12.qualityState, quality);
        assert.equal(state.groups12.available, available);
        if (omitted.length) assert.deepEqual(state.groups12.missingGroups,
            omitted.includes("JPM") ? ["JPM"] : omitted);
    }
});

test("normalizedDirection deltaだけを公開する", async () => {
    const runtime = Runtime.createRuntime();
    await runtime.publish(publication({ majorNormalized: 0.4,
        current: data({ SG: 112 }) }), { isCurrentPublication: current });
    const state = runtime.getState();
    assert.ok(Math.abs(state.groups12.normalizedDirection - 0.5) < 1e-12);
    assert.ok(Math.abs(state.comparison.normalizedDirectionDelta - 0.1) < 1e-12);
    assert.equal("confidenceDelta" in state.comparison, false);
    assert.equal("qualityFactorDelta" in state.comparison, false);
});

test("agreement taxonomyは既存normalizedDirectionだけで決定する", () => {
    const classify = Runtime.classifyAgreement;
    const value = normalizedDirection => ({ available: true,
        normalizedDirection });
    assert.equal(classify(value(0.5), value(0.5)), "same_direction");
    assert.equal(classify(value(0.5), value(0.8)), "different_strength");
    assert.equal(classify(value(0.5), value(-0.2)), "opposite_direction");
    assert.equal(classify(value(0), value(0.2)), "zero_involved");
    assert.equal(classify({ available: false }, value(0.2)), "unavailable");
});

test("dominantGroup・missingGroups・config/scoring versionを保持する", async () => {
    const runtime = Runtime.createRuntime();
    await runtime.publish(publication({
        current: data({ SG: 125 }, ["MITSUBISHI_UFJ"])
    }), { isCurrentPublication: current });
    const state = runtime.getState();
    assert.equal(state.groups12.dominantGroup, "SG");
    assert.deepEqual(state.groups12.missingGroups, ["MITSUBISHI_UFJ"]);
    assert.equal(state.configIdentity.configVersion,
        "weekly-scoring-groups-v1");
    assert.equal(state.configIdentity.scoringVersion,
        "twelve-group-shadow-scoring-v1");
});

test("new request invalidationは旧stateをcurrentとして残さない", async () => {
    const runtime = Runtime.createRuntime();
    await runtime.publish(publication(), { isCurrentPublication: current });
    runtime.invalidate("new_weekly_request");
    const state = runtime.getState();
    assert.equal(state.status, "unavailable");
    assert.equal(state.reason, "new_weekly_request");
    assert.equal(state.major5, null);
    assert.equal(state.groups12, null);
    assert.equal(state.publicationGeneration, 2);
});

test("stale async publicationはinvalidate後にcommitされない", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const runtime = Runtime.createRuntime({
        adaptFormalPair: async pair => {
            await gate;
            return adapter.adaptFormalPair(pair);
        }
    });
    const pending = runtime.publish(publication(),
        { isCurrentPublication: current });
    runtime.invalidate("new_weekly_request");
    release();
    assert.deepEqual(await pending,
        { published: false, reason: "stale_publication" });
    assert.equal(runtime.getState().reason, "new_weekly_request");
});

test("weekly generation後退をrejectしpublication generationは単調増加する",
    async () => {
        const runtime = Runtime.createRuntime();
        await runtime.publish(publication({ generation: 8 }),
            { isCurrentPublication: current });
        const stale = await runtime.publish(publication({ generation: 7 }),
            { isCurrentPublication: current });
        assert.equal(stale.reason, "stale_generation");
        assert.equal(runtime.getState().publicationGeneration, 2);
    });

test("gettersはdetachedかつdeep frozenで再計算しない", async () => {
    let calls = 0;
    const runtime = Runtime.createRuntime({ adaptFormalPair: async pair => {
        calls += 1;
        return adapter.adaptFormalPair(pair);
    } });
    await runtime.publish(publication(), { isCurrentPublication: current });
    const first = runtime.getState();
    const second = runtime.getState();
    const diagnostics = runtime.getDiagnostics();
    assert.notEqual(first, second);
    assert.equal(calls, 1);
    assert.equal(Object.isFrozen(first.groups12.missingGroups), true);
    assert.equal(Object.isFrozen(first.groups12.groups.SBI_RAKUTEN.members), true);
    assert.notEqual(first.groups12.groups, second.groups12.groups);
    assert.equal(Object.isFrozen(diagnostics), true);
    assert.notEqual(diagnostics, first.diagnostics);
});

test("formal/shadow/trade/Overall guardsとdiagnosticsを固定する", async () => {
    const runtime = Runtime.createRuntime();
    await runtime.publish(publication(), { isCurrentPublication: current });
    const state = runtime.getState();
    assert.equal(state.major5.formalApplied, true);
    assert.equal(state.groups12.shadowOnly, true);
    assert.equal(state.groups12.referenceOnly, true);
    assert.equal(state.groups12.formalApplied, false);
    assert.equal(state.groups12.overallV2Eligible, false);
    assert.equal(state.comparison.tradeDecisionEligible, false);
    assert.equal(state.comparison.overallV2Applied, false);
    for (const key of ["storageAccessed", "databaseAccessed", "fetchTriggered",
        "formalRecalculationTriggered", "domMutated", "overallV2Applied",
        "tradeDecisionEligible", "formalApplied"]) {
        assert.equal(state.diagnostics[key], false);
    }
});

test("runtime moduleはstorage/fetch/DOM/Overall/Major5再計算から隔離する", () => {
    const source = fs.readFileSync(require.resolve(
        "../js/weeklyFuturesTwelveGroupDualRunRuntime.js"
    ), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|setItem/);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|ipcRenderer/);
    assert.doesNotMatch(source, /document\.|querySelector|createElement/);
    assert.doesNotMatch(source,
        /calculateOverallJudgmentV2|createWeeklyComponentInputV2/);
    assert.doesNotMatch(source, /calculateWeeklyBrokerJudgment/);
});

test("rendererは依存順にloadし既存formal publication後だけ接続する", () => {
    const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
    const script = fs.readFileSync(require.resolve("../js/script.js"), "utf8");
    const shadowIndex = html.indexOf(
        "js/weeklyFuturesTwelveGroupShadow.js"
    );
    const adapterIndex = html.indexOf(
        "js/weeklyFuturesTwelveGroupFormalPairAdapter.js"
    );
    const runtimeIndex = html.indexOf(
        "js/weeklyFuturesTwelveGroupDualRunRuntime.js"
    );
    assert.ok(shadowIndex >= 0 && shadowIndex < adapterIndex);
    assert.ok(adapterIndex < runtimeIndex);
    assert.match(script, /await window\.publishWeeklyFormalIdentityFact/);
    assert.match(script,
        /await window\.publishWeeklyFuturesTwelveGroupDualRun/);
    assert.match(script,
        /await window\.publishWeeklyFuturesTwelveGroupDualRun[\s\S]*renderWeeklyTwelveGroupReference\(\)/);
    assert.match(html,
        /invalidateWeeklyFuturesTwelveGroupDualRun\?\.\("new_weekly_request"\)/);
});

test("OverallV2入力関数とMajor5計算へ12-groupを混入しない", () => {
    const script = fs.readFileSync(require.resolve("../js/script.js"), "utf8");
    const weeklyInput = script.slice(
        script.indexOf("function createWeeklyComponentInputV2"),
        script.indexOf("function calculateOptionMapOverallJudgmentV2")
    );
    const weeklyCandidate = script.slice(
        script.indexOf("function updateWeeklyCandidateV2"),
        script.indexOf("window.calculateOptionMapOverallJudgmentV2")
    );
    assert.doesNotMatch(weeklyInput, /TwelveGroup|DualRun|groups12/);
    assert.match(weeklyCandidate, /calculateWeeklyBrokerJudgment\(previous, current\)/);
    assert.doesNotMatch(weeklyCandidate,
        /calculatePair|adaptFormalPair|groups12|normalizedDirectionDelta/);
});
