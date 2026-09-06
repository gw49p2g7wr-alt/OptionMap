"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Selector = require("../js/qriOptionIvContractSelector.js");

const source = (role, contract, versionKey, origin = "history") => ({ available: true,
    role, origin, sourceStatus: origin === "live" ? "acquired" : undefined,
    contract, versionKey, canonical: { contract } });

test("history-only reload creates three fixed-role contract choices", () => {
    const choices = Selector.buildChoices({ defaultContract: "2026-09", historySources: {
        active: source("active", "2026-09", "a"),
        next: source("next", "2026-10", "b"),
        major_sq: source("major_sq", "2026-12", "c") } });
    assert.deepEqual(choices.map(item => [item.role, item.contract, item.sourceKind]), [
        ["active", "2026-09", "history"], ["next", "2026-10", "history"],
        ["major_sq", "2026-12", "history"]]);
});

test("deferred/unavailable roles and unrelated old contracts are never enumerated", () => {
    const choices = Selector.buildChoices({ defaultContract: "2026-09", historySources: {
        active: source("active", "2026-09", "a"), next: null, major_sq: null,
        old: source("old", "2026-06", "old") } });
    assert.deepEqual(choices.map(item => item.contract), ["2026-09"]);
});

test("live supersedes history for the same role", () => {
    const choices = Selector.buildChoices({ defaultContract: "2026-09",
        activeRuntime: source("active", "2026-09", "live", "live"),
        historySources: { active: source("active", "2026-09", "saved") } });
    assert.deepEqual([choices[0].sourceKind, choices[0].versionKey], ["live", "live"]);
});

test("next and major_sq same canonical produce one button and preserve role aliases", () => {
    const common = "same"; const choices = Selector.buildChoices({ historySources: {
        next: source("next", "2026-12", common),
        major_sq: source("major_sq", "2026-12", common) } });
    assert.equal(choices.length, 1);
    assert.deepEqual(choices[0].roles, ["next", "major_sq"]);
    assert.equal(Selector.resolveSelection("major_sq", choices), "next");
});

test("same-contract conflicting versions follow explicit next-before-major priority", () => {
    const choices = Selector.buildChoices({ historySources: {
        next: source("next", "2026-12", "next-v"),
        major_sq: source("major_sq", "2026-12", "major-v") } });
    assert.deepEqual([choices.length, choices[0].role, choices[0].versionKey],
        [1, "next", "next-v"]);
    assert.equal(choices[0].conflict, true);
});

test("same-contract live source deterministically supersedes a conflicting history role", () => {
    const choices = Selector.buildChoices({ referenceSources: {
        major_sq: source("major_sq", "2026-12", "live-v", "live") }, historySources: {
        next: source("next", "2026-12", "history-v") } });
    assert.deepEqual([choices.length, choices[0].role, choices[0].sourceKind,
        choices[0].versionKey, choices[0].conflict],
    [1, "major_sq", "live", "live-v", true]);
});

test("selection is retained while available and falls back only when unavailable", () => {
    const choices = Selector.buildChoices({ defaultContract: "2026-09", historySources: {
        active: source("active", "2026-09", "a"),
        next: source("next", "2026-10", "b") } });
    assert.equal(Selector.resolveSelection("next", choices), "next");
    assert.equal(Selector.resolveSelection("major_sq", choices), "active");
    assert.equal(Object.isFrozen(choices[0].roles), true);
});
