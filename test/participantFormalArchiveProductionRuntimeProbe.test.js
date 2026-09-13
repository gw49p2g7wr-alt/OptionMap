"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Probe = require("../js/formalArchive/participantFormalArchiveProductionRuntimeProbe.js");
test("runtime probe identifies packaged and development OptionMap main processes", () => {
    const output = ` 100 /Applications/OptionMap.app/Contents/MacOS/OptionMap\n` +
        ` 101 node /Users/natsu/OptionMap/node_modules/.bin/electron .\n` +
        ` 102 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT`;
    assert.deepEqual(Probe.detectOptionMapProcesses(output).map(item => item.pid), [100, 101]);
});
test("runtime probe fails closed and ignores its own pid", async () => {
    const probe = Probe.createMacOsRuntimeProbe({ currentPid: 100, execFile: async () => ({
        stdout: " 100 /Applications/OptionMap.app/Contents/MacOS/OptionMap\n" }) });
    assert.equal((await probe()).stopped, true);
    const failed = Probe.createMacOsRuntimeProbe({ execFile: async () => { throw new Error("denied"); } });
    assert.equal((await failed()).stopped, false); assert.equal((await failed()).reason,
        "process_probe_failed");
});
