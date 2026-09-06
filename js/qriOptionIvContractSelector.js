(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriOptionIvContractSelector = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const ROLES = Object.freeze(["active", "next", "major_sq"]);
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value);
    }
    const contract = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "") ? value : null;
    const available = source => source?.available === true &&
        contract(source.contract) === source?.canonical?.contract;

    function buildChoices(input = {}) {
        const live = { active: input.activeRuntime,
            next: input.referenceSources?.next, major_sq: input.referenceSources?.major_sq };
        const history = input.historySources || {};
        const candidates = ROLES.map(role => {
            const liveSource = available(live[role]) ? live[role] : null;
            const historySource = available(history[role]) ? history[role] : null;
            const source = liveSource || historySource;
            return { role, roles: [role], contract: contract(source?.contract) ||
                (role === "active" ? contract(input.defaultContract) : null),
            available: !!source, sourceKind: liveSource ? "live" : historySource ? "history" : null,
            versionKey: source?.versionKey || null };
        }).filter(item => item.contract && (item.role === "active" || item.available));
        const choices = [];
        for (const item of candidates) {
            const existing = choices.find(choice => choice.contract === item.contract);
            if (!existing) { choices.push(item); continue; }
            if (!existing.available && item.available) {
                Object.assign(existing, item, { roles: [...existing.roles, ...item.roles] });
                continue;
            }
            if (existing.available && item.available && existing.versionKey === item.versionKey) {
                existing.roles.push(item.role);
            } else if (existing.available && item.available) {
                const roles = [...existing.roles, ...item.roles];
                if (existing.sourceKind === "history" && item.sourceKind === "live") {
                    Object.assign(existing, item, { roles, conflict: true });
                } else {
                    existing.conflict = true;
                }
            }
        }
        return freeze(clone(choices));
    }

    function resolveSelection(selectedRole, choices) {
        const exact = choices.find(item => item.role === selectedRole && item.available);
        if (exact) return exact.role;
        const alias = choices.find(item => item.available && item.roles.includes(selectedRole));
        if (alias) return alias.role;
        return choices.find(item => item.role === "active" && item.available)?.role ||
            choices.find(item => item.available)?.role || "active";
    }
    return Object.freeze({ ROLES, buildChoices, resolveSelection });
});
