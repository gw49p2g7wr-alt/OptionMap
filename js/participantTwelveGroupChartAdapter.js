(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const shadow = commonJs
        ? require("./weeklyFuturesTwelveGroupShadow.js")
        : root.OptionMapWeeklyFuturesTwelveGroupShadow;
    const api = factory(shadow);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapParticipantTwelveGroupChartAdapter = api;
})(typeof window !== "undefined" ? window : globalThis, function (shadow) {
    "use strict";

    const CORE_KEYS = Object.freeze(["JPM", "GS", "NOMURA", "BNP", "ABN"]);
    const DISPLAY_NAMES = Object.freeze({
        JPM: "JPM",
        GS: "GS",
        NOMURA: "野村",
        BNP: "BNP",
        ABN: "ABN",
        SG: "ソシエテG",
        MORGAN_MUFG: "MorganMUFG",
        SBI_RAKUTEN: "SBI＋楽天",
        MITSUBISHI_UFJ: "三菱UFJ",
        DAIWA: "大和",
        CITI: "シティ",
        BARCLAYS: "バークレイズ"
    });
    const GROUPS = shadow?.GROUP_DEFINITIONS || [];
    const SELECTOR_DEFINITIONS = Object.freeze(GROUPS.map(group =>
        Object.freeze({
            key: group.id,
            displayName: DISPLAY_NAMES[group.id] || group.id,
            existingMajor5: CORE_KEYS.includes(group.id),
            strictAdditional: !CORE_KEYS.includes(group.id),
            composite: group.composite === true
        })
    ));
    const FILES = Object.freeze({
        day: Object.freeze(["dayAuction", "dayJnet"]),
        night: Object.freeze(["nightAuction", "nightJnet"])
    });

    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) {
            return value;
        }
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }

    const groupFor = key => GROUPS.find(group => group.id === key) || null;
    const isExistingMajor5 = key => CORE_KEYS.includes(key);
    const isAdditionalGroup = key => Boolean(groupFor(key)) &&
        !isExistingMajor5(key);

    function resolveMember(records, member) {
        const source = Array.isArray(records) ? records : [];
        const codeMatches = source.filter(record =>
            record?.participantCode === member.participantCode
        );
        const nameMatches = source.filter(record =>
            record?.company === member.brokerName
        );
        const exact = codeMatches.filter(record =>
            record.company === member.brokerName
        );
        if (nameMatches.some(record => !record.participantCode)) {
            return { available: false, value: null,
                reason: "legacy_code_missing" };
        }
        if (codeMatches.length !== exact.length ||
            nameMatches.length !== exact.length) {
            return { available: false, value: null,
                reason: "identity_mismatch" };
        }
        if (exact.length === 0) {
            return { available: false, value: null, reason: "unpublished" };
        }
        const values = exact.map(record => Number(record.volume));
        if (values.some(value => !Number.isFinite(value) || value < 0)) {
            return { available: false, value: null, reason: "invalid_volume" };
        }
        return {
            available: true,
            value: values.reduce((sum, value) => sum + value, 0),
            reason: null
        };
    }

    function resolveSession(snapshot, fileKeys, group) {
        const members = group.members.map(member => {
            const files = fileKeys.map(fileKey => ({
                fileKey,
                ...resolveMember(
                    snapshot?.parsedDayData?.[fileKey]?.large?.records,
                    member
                )
            }));
            const unavailable = files.find(file => !file.available);
            return {
                key: member.key,
                available: !unavailable,
                value: unavailable ? null : files.reduce(
                    (sum, file) => sum + file.value, 0
                ),
                reason: unavailable?.reason || null,
                files
            };
        });
        const unavailable = members.find(member => !member.available);
        return {
            available: !unavailable,
            value: unavailable ? null : members.reduce(
                (sum, member) => sum + member.value, 0
            ),
            reason: unavailable?.reason || null,
            members
        };
    }

    function classificationForDate(date, intervals) {
        const interval = (Array.isArray(intervals) ? intervals : []).find(item =>
            date > item.from && date <= item.to
        );
        return interval?.available === true ? interval.status : "unconfirmed";
    }

    function createAdditionalClassificationHistory(versions, groupKey) {
        const group = groupFor(groupKey);
        if (!group || isExistingMajor5(groupKey)) return freeze([]);
        const source = Array.isArray(versions) ? versions : [];
        const intervals = [];
        for (let index = 1; index < source.length; index += 1) {
            const previous = source[index - 1];
            const current = source[index];
            const result = shadow.calculateGroup(previous, current, group);
            intervals.push({
                from: previous.sourceDate || previous.date,
                to: current.sourceDate || current.date,
                available: result.availability === true,
                status: result.availability === true
                    ? result.status : "unconfirmed",
                reason: result.reason || null
            });
        }
        return freeze(intervals);
    }

    function createAdditionalSeries(snapshots, groupKey, intervals = []) {
        const group = groupFor(groupKey);
        if (!group || isExistingMajor5(groupKey)) {
            return freeze({
                groupKey,
                status: "unavailable",
                reason: "strict_additional_group_required",
                points: [],
                diagnostics: { availableDays: 0, unavailableDays: 0,
                    identityUnverifiedDays: 0 }
            });
        }
        const points = (Array.isArray(snapshots) ? snapshots : []).map(snapshot => {
            const date = String(snapshot?.sourceDate || "").slice(0, 10);
            const day = resolveSession(snapshot, FILES.day, group);
            const night = resolveSession(snapshot, FILES.night, group);
            const reasons = [day.reason, night.reason].filter(Boolean);
            return {
                date,
                day: day.available ? day.value : null,
                night: night.available ? night.value : null,
                available: day.available && night.available,
                status: classificationForDate(date, intervals),
                reason: reasons[0] || null,
                identityVerified: !reasons.some(reason =>
                    ["legacy_code_missing", "identity_mismatch"].includes(reason)
                ),
                sessions: { day, night }
            };
        });
        return freeze({
            groupKey,
            status: "available",
            reason: null,
            points,
            diagnostics: {
                availableDays: points.filter(point => point.available).length,
                unavailableDays: points.filter(point => !point.available).length,
                identityUnverifiedDays: points.filter(point =>
                    !point.identityVerified
                ).length
            }
        });
    }

    return freeze({
        CORE_KEYS,
        DISPLAY_NAMES,
        SELECTOR_DEFINITIONS,
        FILES,
        isExistingMajor5,
        isAdditionalGroup,
        resolveMember,
        resolveSession,
        classificationForDate,
        createAdditionalClassificationHistory,
        createAdditionalSeries
    });
});
