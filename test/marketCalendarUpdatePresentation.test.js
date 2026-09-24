"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Presentation = require("../js/marketCalendarRuntime/calendarUpdatePresentation.js");

test("idle/checking/success/partial/failed/unavailableを保存と誤認しない文言へ変換", () => {
  const cases = [
    ["idle", /未確認/, /公式データを確認/], ["checking", /確認中/, /確認中/],
    ["success", /確認済み/, /再確認/], ["partial", /一部失敗/, /失敗sourceを再確認/],
    ["failed", /確認に失敗/, /再確認/], ["unavailable", /確認できません/, /再確認/]
  ];
  for (const [state, status, button] of cases) {
    const result = Presentation.build({ state, checkedAt: "2026-09-25T05:32:00.000Z",
      requestedSourceCount: 12, successfulSourceCount: state === "partial" ? 10 : 12,
      sources: state === "partial" ? [{ sourceId: "x", displayName: "安全な名前",
        status: "failed", reasonClass: "timeout" }] : [] });
    assert.match(result.statusText, status); assert.match(result.buttonText, button);
    assert.doesNotMatch(result.statusText, /更新完了|保存済み/);
    assert.equal(result.writerQualifier, "保存は行っていません");
  }
});

test("diagnosticはtext用のsource名とreason classだけを構成", () => {
  const result = Presentation.build({ state: "partial", requestedSourceCount: 12,
    successfulSourceCount: 10, sources: [{ displayName: "<img onerror=alert(1)>",
      status: "failed", reasonClass: "mime_mismatch" }] });
  assert.equal(result.detailsText, "<img onerror=alert(1)>：mime_mismatch");
  assert.equal(result.detailsHidden, false);
});
