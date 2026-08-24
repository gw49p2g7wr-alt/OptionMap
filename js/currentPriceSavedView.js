(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapCurrentPriceSavedView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const VIEW_VERSION = 1;
    const SEVERITY_CLASSES = ["current-price-saved-neutral", "current-price-saved-caution"];

    function renderCurrentPriceSavedUiState(viewState, documentRef = globalThis.document) {
        const container = documentRef?.getElementById("currentPriceSavedState");
        if (!container) return Object.freeze({ rendered: false, reason: "container_missing" });

        const visible = viewState?.visible === true;
        container.hidden = !visible;
        SEVERITY_CLASSES.forEach(name => container.classList.remove(name));
        if (visible) {
            container.classList.add(viewState.severity === "caution"
                ? "current-price-saved-caution" : "current-price-saved-neutral");
        }

        const set = (id, value) => {
            const element = documentRef.getElementById(id);
            if (element) element.textContent = visible && typeof value === "string" ? value : "";
        };
        set("currentPriceSavedTitle", viewState?.title);
        set("currentPriceSavedPrice", viewState?.priceText);
        set("currentPriceSavedContract", viewState?.contractText);
        set("currentPriceSavedMetadata", Array.isArray(viewState?.metadataLines)
            ? viewState.metadataLines.join(" / ") : "");
        set("currentPriceSavedMessage", viewState?.message);
        set("currentPriceSavedNote", viewState?.note);

        return Object.freeze({ rendered: true, visible,
            state: typeof viewState?.state === "string" ? viewState.state : "hidden",
            viewVersion: VIEW_VERSION });
    }

    return Object.freeze({ VIEW_VERSION, renderCurrentPriceSavedUiState });
});
