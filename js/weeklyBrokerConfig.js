(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) root.OptionMapWeeklyBrokerConfig = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const GROUP = Object.freeze({
        groupId: "core-weekly",
        groupLabel: "主要5社",
        groupVersion: 1
    });

    const PARTICIPANTS = Object.freeze([
        Object.freeze({
            key: "JPM",
            participantCode: "11714",
            brokerName: "ＪＰモルガン証券",
            displayName: "JPM",
            order: 1,
            statusElementId: "weeklyStatusJPM"
        }),
        Object.freeze({
            key: "GS",
            participantCode: "11560",
            brokerName: "ゴールドマン証券",
            displayName: "GS",
            order: 2,
            statusElementId: "weeklyStatusGS"
        }),
        Object.freeze({
            key: "NOMURA",
            participantCode: "12400",
            brokerName: "野村証券",
            displayName: "野村",
            order: 3,
            statusElementId: "weeklyStatusNOMURA"
        }),
        Object.freeze({
            key: "BNP",
            participantCode: "12428",
            brokerName: "ＢＮＰパリバ証券",
            displayName: "BNP",
            order: 4,
            statusElementId: "weeklyStatusBNP"
        }),
        Object.freeze({
            key: "ABN",
            participantCode: "12479",
            brokerName: "ＡＢＮクリアリン証券",
            displayName: "ABN",
            order: 5,
            statusElementId: "weeklyStatusABN"
        })
    ]);

    const BROKER_MAP = Object.freeze(Object.fromEntries(
        PARTICIPANTS.map(participant => [
            participant.key,
            participant.brokerName
        ])
    ));

    return Object.freeze({
        GROUP,
        PARTICIPANTS,
        BROKER_MAP
    });
});
