(function (root, factory) {
    const common = typeof module === "object" && module.exports && !(root && root.document);
    const contract = common ? require("./sourceContract.js") : root?.OptionMapJpxDerivativesOpenInterestSourceContract;
    const api = factory(contract); if (common) module.exports = api;
    if (root) root.OptionMapJpxDerivativesOpenInterestIdentity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (contract) {
    "use strict";
    async function derive(canonical, evidence) {
        if (canonical?.sourceId !== contract.SOURCE_ID || canonical?.schemaVersion !== contract.SCHEMA_VERSION)
            throw new TypeError("canonical_contract_invalid");
        const semanticIdentity = await contract.sha256(canonical);
        const acquisitionEvidenceIdentity = await contract.sha256(evidence);
        const logicalKey = `${contract.SOURCE_ID}|${canonical.sourceDate}`;
        const revisionKey = `${logicalKey}|sha256:${semanticIdentity}`;
        return Object.freeze({ logicalKey, revisionKey, semanticIdentity, acquisitionEvidenceIdentity });
    }
    async function storageMutationIdentity(plan) { return contract.sha256({
        contractVersion: "jpx-open-interest-storage-plan-v1", plan }); }
    // Exactly the existing hash input: recursively sorted object keys, unchanged array order.
    // getAll() supplies primary-key ordered records; do not invent a second normalization in writers.
    function preconditionMaterial(precondition) { return JSON.stringify(contract.stable({
        contractVersion: "jpx-open-interest-precondition-v1", precondition })); }
    async function preconditionIdentity(precondition) { return contract.sha256(preconditionMaterial(precondition)); }
    return Object.freeze({ derive, storageMutationIdentity, preconditionMaterial, preconditionIdentity });
});
