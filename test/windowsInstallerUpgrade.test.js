const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const includePath = packageJson.build?.nsis?.include;
const source = fs.readFileSync(path.join(root, includePath), "utf8");

test("Windows installer uses the bounded beta.5/beta.6 compatibility include", () => {
    assert.equal(includePath, "build/installer-upgrade-compat.nsh");
    assert.match(source, /!macro customInit/);
    assert.match(source, /DisplayVersion/);
    assert.match(source, /1\.1\.0-beta\.5/);
    assert.match(source, /1\.1\.0-beta\.6/);
    assert.match(source, /\$LOCALAPPDATA\\Programs\\optionmap/);
});

test("compatibility update is fail-closed and leaves userData outside its mutation boundary", () => {
    assert.match(source, /tasklist \/FI/);
    assert.match(source, /findstr\.exe.*APP_EXECUTABLE_FILENAME/);
    assert.match(source, /\$R9 != 1/);
    assert.match(source, /SetErrorLevel 2[\s\S]*Quit/);
    assert.match(source, /DeleteRegValue[\s\S]*UninstallString/);
    assert.doesNotMatch(source, /RMDir|delete-app-data|KEEP_APP_DATA|\\Roaming\\optionmap/);
    assert.match(source, /!macro customInstall[\s\S]*SetOverwrite on/);
});
