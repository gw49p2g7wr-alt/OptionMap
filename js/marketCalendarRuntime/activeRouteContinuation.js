"use strict";
const Authority = require("./calendarRouteAuthority.js");
const Policy = require("./routeReevaluationPolicy.js");
const formalState = Object.freeze({ databaseStatus: "absent", schemaStatus: "compatible",
  sourceCursorStatus: "absent", lastAcceptedAt: null, securityStatus: "clear" });
function plan({ sourceId, state, authority, trigger, requestedAt, attemptCount }) {
  const selected = Authority.selectRoute({ sourceId, operation: "source-document-set" }, authority);
  const decision = Policy.evaluateBoundUpdate({ sourceId, runtimeState: state, trigger, requestedAt,
    formalState, sessionState: { attemptCount: trigger === "startup" ? attemptCount : 0 } }, authority);
  const transition = Policy.evaluate({ sourceId, state, authority, requestedAt });
  if (transition.eligible) return { selected, decision, mode: "initial_reevaluation", acquire: true };
  if (decision.decision === "skip") return { selected, decision, mode: "skip", acquire: false };
  if (!state && ["update", "retry"].includes(decision.decision) && Policy.initialBinding(sourceId, authority))
    return { selected, decision, mode: "initial_active_route", acquire: true };
  if ((state?.reevaluation === null || state?.reevaluation?.status === "completed") &&
      selected.activationState === "alternative_active" &&
      Policy.sameBinding(state.routeBinding, Policy.binding(selected)))
    return { selected, decision, mode: ["update", "retry"].includes(decision.decision) ?
      "normal_active_route" : decision.decision, acquire: ["update", "retry"].includes(decision.decision) };
  return { selected, decision, mode: "blocked", acquire: false };
}
module.exports = Object.freeze({ plan });
