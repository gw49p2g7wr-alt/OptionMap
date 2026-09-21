(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory();
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportSourceFaithfulCanonical = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const FILE_ROLES = Object.freeze(["dayAuction", "dayJnet", "nightAuction", "nightJnet"]);
    const ROLE_META = Object.freeze({
        dayAuction: Object.freeze({ session: "day", executionType: "auction" }),
        dayJnet: Object.freeze({ session: "day", executionType: "jnet" }),
        nightAuction: Object.freeze({ session: "night", executionType: "auction" }),
        nightJnet: Object.freeze({ session: "night", executionType: "jnet" })
    });
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const recordsFromParticipantFile = file => Object.values(file?.data || {})
        .flatMap(group => Array.isArray(group?.records) ? group.records : []);
    const loss = values => ({ rawHtmlRetained: false, rawExcelRetained: false,
        originalRowIdentityRetained: false, originalColumnIdentityRetained: false,
        unknownFieldsRetained: false, ...values });

    function revisionInventory(history) {
        const revisions = [];
        for (const entry of history?.entries || []) for (const revision of entry.revisions || []) {
            revisions.push({ entry, revision });
        }
        return revisions;
    }

    function revisionByVersion(history, versionKey) {
        if (!versionKey) return null;
        const matches = revisionInventory(history).filter(item =>
            item.revision?.versionKey === versionKey);
        return matches.length === 1 ? matches[0] : null;
    }

    function revisionProjection(match) {
        if (!match) return null;
        const { revisions: _revisions, ...entry } = match.entry;
        return { entry: clone(entry),
            revision: clone(match.revision) };
    }

    function qriOpenInterest(v1, history) {
        const sectionFor = role => role === "active" ? v1?.sections?.qriOptions :
            role === "next" ? v1?.sections?.qriOptionsNextContract :
                v1?.sections?.qriOptionsMajorSqNextContract;
        const roles = {};
        for (const role of ["active", "next", "majorSqNext"]) {
            const section = sectionFor(role);
            const versionKey = section?.authority?.versionKey || section?.details?.versionKey || null;
            roles[role] = { status: section?.status || "unavailable",
                reason: section?.reason || null, basisVersionKey: versionKey,
                selected: revisionProjection(revisionByVersion(history, versionKey)) };
        }
        return { status: roles.active.selected ? "available" : "unavailable",
            roles, lossDisclosure: loss({ zeroSemantics: "retained_by_qri_canonical",
                unpublishedSemantics: "published_false_value_null" }) };
    }

    function qriIv(v1) {
        const section = v1?.sections?.qriOptionIv;
        return { status: section?.status || "unavailable", reason: section?.reason || null,
            roles: clone(section?.details?.roles || []),
            payloads: clone(section?.details?.payloads || []),
            lossDisclosure: loss({ zeroSemantics: "retained_by_iv_canonical",
                missingInvalidSemantics: "retained_by_status_and_source_format" }) };
    }

    function weekly(v1, history, sectionName) {
        const section = v1?.sections?.[sectionName];
        const current = section?.details?.currentIdentity?.versionKey ||
            section?.authority?.versionKey || null;
        const previous = section?.details?.previousIdentity?.versionKey ||
            section?.details?.comparison?.previousVersionKey || null;
        return { status: section?.status || "unavailable", reason: section?.reason || null,
            current: revisionProjection(revisionByVersion(history, current)),
            previous: revisionProjection(revisionByVersion(history, previous)),
            lossDisclosure: loss({ zeroSemantics: "parser_dependent_not_recoverable",
                blankSemantics: "parser_dependent_not_recoverable" }) };
    }

    function participants(cache) {
        if (!object(cache) || !object(cache.files)) return { status: "unavailable",
            reason: "participant_cache_unavailable", completeSet: null, files: {},
            lossDisclosure: loss({ zeroSemantics: "retained_when_present_in_canonical" }) };
        const files = {};
        for (const role of FILE_ROLES) {
            const file = cache.files[role];
            const meta = ROLE_META[role];
            files[role] = file ? { fileRole: role, sessionKind: meta.session,
                executionType: meta.executionType, status: file.status,
                sourceDate: file.sourceDate, sourceDateKind: file.sourceDateKind,
                sourceUrl: file.sourceUrl, signatureAlgorithm: file.signatureAlgorithm,
                signature: file.signature, versionKey: file.versionKey,
                canonical: clone(file.data), records: recordsFromParticipantFile(file)
                    .map(record => ({ provenance: { fileRole: role }, record: clone(record) })) } : null;
        }
        return { status: FILE_ROLES.every(role => files[role]) ? "available" : "partial",
            reason: FILE_ROLES.every(role => files[role]) ? null : "participant_file_role_missing",
            completeSet: { version: cache.version, parserVersion: cache.parserVersion,
                source: cache.source, sourceDate: cache.sourceDate, fetchedAt: cache.fetchedAt,
                status: cache.status, signatureAlgorithm: cache.signatureAlgorithm,
                signature: cache.signature, versionKey: cache.versionKey }, files,
            lossDisclosure: loss({ zeroSemantics: "retained_when_present_in_canonical",
                fileRoleRetainedPerRecord: true }) };
    }

    async function collect(configuration = {}, v1Export) {
        const [qriHistory, weeklyFuturesHistory, weeklyOptionsLoaded] = await Promise.all([
            configuration.readQriHistory?.(), configuration.readWeeklyFuturesHistory?.(),
            configuration.readWeeklyOptionsHistory?.()
        ]);
        const participantCache = await configuration.readParticipantCache?.();
        return { contractVersion: 1, selectionPolicy: {
            scope: "export_basis_revisions", wholeHistoryIncluded: false,
            rawHtmlIncluded: false, rawExcelIncluded: false },
        qriOpenInterest: qriOpenInterest(v1Export, qriHistory?.history || qriHistory),
        qriImpliedVolatility: qriIv(v1Export),
        weeklyFutures: weekly(v1Export, weeklyFuturesHistory?.history || weeklyFuturesHistory,
            "weeklyFutures"),
        weeklyOptions: weekly(v1Export, weeklyOptionsLoaded?.history || weeklyOptionsLoaded,
            "weeklyOptions"),
        participants: participants(participantCache) };
    }

    return Object.freeze({ FILE_ROLES, collect, participants, revisionByVersion });
});
