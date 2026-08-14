(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.OptionMapOverallJudgmentV2 = api;
    }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const CONFIG = Object.freeze({
        plannedComponents: Object.freeze(["option", "weekly"]),
        weights: Object.freeze({ option: 55, weekly: 45 }),
        optionNormalizationBase: 8,
        weeklyNormalizationBase: 0.10,
        confidenceWeights: Object.freeze({
            coverage: 0.35,
            quality: 0.30,
            evidence: 0.20,
            agreement: 0.15
        }),
        singleComponentAgreement: 0.5,
        timeHorizon: Object.freeze({
            code: "multi_day",
            label: "1日～数日"
        })
    });

    const clamp = (value, minimum, maximum) =>
        Math.min(maximum, Math.max(minimum, value));

    function getDirectionLabel(direction) {
        if (!Number.isFinite(direction)) return null;
        if (direction >= 60) return "強い買い優勢";
        if (direction >= 20) return "買い優勢";
        if (direction <= -60) return "強い売り優勢";
        if (direction <= -20) return "売り優勢";
        return "中立";
    }

    function unavailableComponent(name, baseWeight, reason) {
        return {
            name,
            available: false,
            invalid: false,
            normalizedDirection: null,
            directionScore: null,
            baseWeight,
            qualityFactor: null,
            effectiveWeight: 0,
            weightedContribution: 0,
            evidenceFactor: null,
            notes: reason ? [reason] : [],
            metadata: null
        };
    }

    function normalizeComponent(name, input, baseWeight) {
        if (!input || input.available !== true) {
            return unavailableComponent(name, baseWeight, input?.reason);
        }

        const normalizedDirection = Number(input.normalizedDirection);
        const qualityFactor = Number(input.qualityFactor);
        const evidenceFactor = Number(input.evidenceFactor);
        const valuesValid = [
            normalizedDirection,
            qualityFactor,
            evidenceFactor,
            baseWeight
        ].every(Number.isFinite);
        const rangesValid =
            normalizedDirection >= -1 && normalizedDirection <= 1 &&
            qualityFactor >= 0 && qualityFactor <= 1 &&
            evidenceFactor >= 0 && evidenceFactor <= 1 &&
            baseWeight > 0;

        if (!valuesValid || !rangesValid) {
            return {
                ...unavailableComponent(name, baseWeight, "入力値が不正です"),
                invalid: true,
                metadata: input.metadata || null
            };
        }

        const effectiveWeight = baseWeight * qualityFactor;

        return {
            name,
            available: effectiveWeight > 0,
            invalid: false,
            normalizedDirection,
            directionScore: normalizedDirection * 100,
            baseWeight,
            qualityFactor,
            effectiveWeight,
            weightedContribution: normalizedDirection * effectiveWeight,
            evidenceFactor,
            notes: Array.isArray(input.notes) ? [...input.notes] : [],
            metadata: input.metadata || null
        };
    }

    function calculateOverallJudgmentV2(input = {}, calculatedAt = null) {
        const components = {};

        for (const name of CONFIG.plannedComponents) {
            components[name] = normalizeComponent(
                name,
                input[name],
                CONFIG.weights[name]
            );
        }

        const invalidComponents = Object.values(components)
            .filter(component => component.invalid)
            .map(component => component.name);
        const availableComponents = Object.values(components)
            .filter(component => component.available);
        const availableComponentCount = availableComponents.length;
        const plannedComponentCount = CONFIG.plannedComponents.length;
        const coverageFactor = availableComponentCount / plannedComponentCount;
        const coverage = coverageFactor * 100;
        const effectiveWeightTotal = availableComponents.reduce(
            (sum, component) => sum + component.effectiveWeight,
            0
        );
        const warnings = Object.values(components)
            .flatMap(component => component.notes)
            .filter(Boolean);

        const metadata = {
            calculatedAt: calculatedAt || new Date().toISOString(),
            availableComponentCount,
            plannedComponentCount,
            coverage,
            timeHorizon: { ...CONFIG.timeHorizon },
            warnings: [...new Set(warnings)]
        };

        if (invalidComponents.length > 0) {
            return {
                status: "invalid_input",
                direction: null,
                directionLabel: null,
                confidence: 0,
                confidenceFactors: {
                    coverage,
                    quality: 0,
                    evidence: 0,
                    agreement: 0
                },
                effectiveWeightTotal,
                components,
                invalidComponents,
                metadata
            };
        }

        if (availableComponentCount === 0 || effectiveWeightTotal <= 0) {
            return {
                status: "unavailable",
                direction: null,
                directionLabel: null,
                confidence: 0,
                confidenceFactors: {
                    coverage: 0,
                    quality: 0,
                    evidence: 0,
                    agreement: 0
                },
                effectiveWeightTotal: 0,
                components,
                invalidComponents: [],
                metadata
            };
        }

        const rawDirection = availableComponents.reduce(
            (sum, component) => sum + component.weightedContribution,
            0
        ) / effectiveWeightTotal * 100;
        const direction = Math.round(clamp(rawDirection, -100, 100));
        const qualityFactor = availableComponents.reduce(
            (sum, component) =>
                sum + component.qualityFactor * component.baseWeight,
            0
        ) / availableComponents.reduce(
            (sum, component) => sum + component.baseWeight,
            0
        );
        const evidenceFactor = availableComponents.reduce(
            (sum, component) =>
                sum + component.evidenceFactor * component.effectiveWeight,
            0
        ) / effectiveWeightTotal;
        const agreementFactor = availableComponentCount === 2
            ? clamp(
                1 - Math.abs(
                    components.option.normalizedDirection -
                    components.weekly.normalizedDirection
                ) / 2,
                0,
                1
            )
            : CONFIG.singleComponentAgreement;
        const confidenceFactors = {
            coverage,
            quality: qualityFactor * 100,
            evidence: evidenceFactor * 100,
            agreement: agreementFactor * 100
        };
        const confidence = Math.round(clamp(
            confidenceFactors.coverage * CONFIG.confidenceWeights.coverage +
            confidenceFactors.quality * CONFIG.confidenceWeights.quality +
            confidenceFactors.evidence * CONFIG.confidenceWeights.evidence +
            confidenceFactors.agreement * CONFIG.confidenceWeights.agreement,
            0,
            100
        ));

        return {
            status: availableComponentCount === plannedComponentCount
                ? "complete"
                : "partial",
            direction,
            directionLabel: getDirectionLabel(direction),
            confidence,
            confidenceFactors,
            effectiveWeightTotal,
            components,
            invalidComponents: [],
            metadata
        };
    }

    return Object.freeze({
        CONFIG,
        clamp,
        getDirectionLabel,
        calculateOverallJudgmentV2
    });
});
