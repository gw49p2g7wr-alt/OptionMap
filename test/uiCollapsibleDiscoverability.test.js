"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../style.css"), "utf8");
const openingTags = [...html.matchAll(/<details\b([^>]*)>/g)].map(match => match[1]);
const summaries = [...html.matchAll(/<summary\b([^>]*)>/g)].map(match => match[1]);

test("all 21 details retain their initial closed native structure", () => {
    assert.equal(openingTags.length, 21);
    assert.equal(summaries.length, 21);
    assert.equal(openingTags.some(attributes => /(?:^|\s)open(?:\s|=|$)/.test(attributes)), false);
    assert.equal(summaries.some(attributes => /(?:role|tabindex|aria-expanded)\s*=/.test(attributes)), false);
});

test("one shared chevron switches from closed to open without a snapshot duplicate", () => {
    assert.match(css, /\.container details > summary::before\s*\{[^}]*content:\s*"▶"/s);
    assert.match(css, /\.container details\[open\] > summary::before\s*\{[^}]*content:\s*"▼"/s);
    assert.equal((css.match(/content:\s*"▶"/g) || []).length, 1);
    assert.equal((css.match(/content:\s*"▼"/g) || []).length, 1);
    assert.doesNotMatch(css, /snapshot-list-card\[open\][^{]*summary::before/);
});

test("the whole native summary has pointer hover focus and open-state feedback", () => {
    assert.match(css, /\.container details > summary\s*\{[^}]*min-height:\s*44px[^}]*cursor:\s*pointer/s);
    assert.match(css, /\.container details > summary:hover\s*\{[^}]*background:/s);
    assert.match(css, /\.container details > summary:focus-visible\s*\{[^}]*outline:/s);
    assert.match(css, /\.container details\[open\] > summary\s*\{[^}]*(?:background|box-shadow):/s);
});

test("native keyboard behavior is preserved without custom click or key handling", () => {
    assert.doesNotMatch(html, /<summary\b[^>]*(?:onclick|onkeydown|role="button")/);
    assert.doesNotMatch(css, /pointer-events:\s*none/);
});

test("hidden disclosure conditions and nested visual hierarchy are retained", () => {
    const twelveGroup = html.match(/<details\b[^>]*id="weeklyTwelveGroupDetails"[^>]*>/)?.[0];
    assert.match(twelveGroup || "", /\shidden(?:\s|>|=)/);
    assert.doesNotMatch(twelveGroup || "", /\sopen(?:\s|>|=)/);
    assert.match(css, /\.container details details > summary\s*\{[^}]*font-size:\s*0\.9em/s);
    assert.match(css, /\.container details details > summary::before\s*\{[^}]*font-size:\s*0\.68rem/s);
});

test("mobile summaries keep a 44px target and reserve chevron space", () => {
    assert.match(css, /@media \(max-width:\s*550px\)[\s\S]*?\.container details > summary\s*\{[^}]*min-height:\s*44px[^}]*padding-left:\s*30px/s);
    assert.match(css, /\.container details > summary::before\s*\{[^}]*position:\s*absolute/s);
    assert.doesNotMatch(css, /\.ui-category-title::before/);
});

test("existing option meaning colors remain unchanged", () => {
    assert.match(css, /--option-call-color:\s*#9b4058/);
    assert.match(css, /--option-put-color:\s*#285f9e/);
});
