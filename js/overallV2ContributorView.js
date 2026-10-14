(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.OptionMapOverallV2ContributorView = api;
    }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const LABELS = Object.freeze({
        option: "Option",
        weekly: "Weekly",
        balanced: "均衡",
        option_only: "Optionのみ",
        weekly_only: "Weeklyのみ",
        unavailable: "不明"
    });

    const finite = value => Number.isFinite(value);

    function availableComponent(component) {
        return Boolean(
            component?.available === true &&
            finite(component.effectiveWeight) &&
            component.effectiveWeight > 0 &&
            finite(component.weightedContribution)
        );
    }

    function direction(value) {
        if (!finite(value) || value === 0) return "neutral";
        return value > 0 ? "buy" : "sell";
    }

    function unavailable() {
        return Object.freeze({
            status: "unavailable",
            label: LABELS.unavailable,
            optionContribution: null,
            weeklyContribution: null,
            opposingComponent: null
        });
    }

    function derive(result) {
        if (!result || !["complete", "partial"].includes(result.status)) {
            return unavailable();
        }

        const option = result.components?.option;
        const weekly = result.components?.weekly;
        const optionAvailable = availableComponent(option);
        const weeklyAvailable = availableComponent(weekly);

        if (!optionAvailable && !weeklyAvailable) return unavailable();

        const optionContribution = optionAvailable
            ? option.weightedContribution : null;
        const weeklyContribution = weeklyAvailable
            ? weekly.weightedContribution : null;

        if (optionAvailable && !weeklyAvailable) {
            return Object.freeze({
                status: "option_only",
                label: LABELS.option_only,
                optionContribution,
                weeklyContribution,
                opposingComponent: null
            });
        }

        if (!optionAvailable && weeklyAvailable) {
            return Object.freeze({
                status: "weekly_only",
                label: LABELS.weekly_only,
                optionContribution,
                weeklyContribution,
                opposingComponent: null
            });
        }

        const optionMagnitude = Math.abs(optionContribution);
        const weeklyMagnitude = Math.abs(weeklyContribution);
        const opposing =
            direction(optionContribution) !== "neutral" &&
            direction(weeklyContribution) !== "neutral" &&
            direction(optionContribution) !== direction(weeklyContribution);
        const status = optionMagnitude === weeklyMagnitude
            ? "balanced"
            : optionMagnitude > weeklyMagnitude ? "option" : "weekly";
        const opposingComponent = opposing && status === "option"
            ? "weekly"
            : opposing && status === "weekly" ? "option" : null;

        return Object.freeze({
            status,
            label: LABELS[status],
            optionContribution,
            weeklyContribution,
            opposingComponent
        });
    }

    function format(view) {
        const resolved = view?.status ? view : unavailable();
        const counter = resolved.opposingComponent === "weekly"
            ? "（Weeklyは逆方向）"
            : resolved.opposingComponent === "option"
                ? "（Optionは逆方向）" : "";
        return `主な寄与：${resolved.label}${counter}`;
    }

    return Object.freeze({ LABELS, derive, format });
});
