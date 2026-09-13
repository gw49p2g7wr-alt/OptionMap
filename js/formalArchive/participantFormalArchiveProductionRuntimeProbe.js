(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(commonJs ? require("node:child_process") : null,
        commonJs ? require("node:util") : null);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapParticipantFormalArchiveProductionRuntimeProbe = api;
})(typeof window !== "undefined" ? window : globalThis, function (childProcess, util) {
    "use strict";
    function detectOptionMapProcesses(output, currentPid = null) {
        return String(output || "").split(/\r?\n/).map(line => { const match = line.match(/^\s*(\d+)\s+(.+)$/);
            return match ? { pid: Number(match[1]), command: match[2] } : null; }).filter(item => item &&
                item.pid !== Number(currentPid) && (/OptionMap\.app\/Contents\/MacOS\/OptionMap(?:\s|$)/
                    .test(item.command) || /node_modules\/\.bin\/electron\s+\./.test(item.command) ||
                    /Electron\.app\/Contents\/MacOS\/Electron\s+\./.test(item.command))); }
    function createMacOsRuntimeProbe(configuration = {}) {
        const execFile = configuration.execFile || (childProcess && util ?
            util.promisify(childProcess.execFile) : null), currentPid = configuration.currentPid ??
                (typeof process === "object" ? process.pid : null);
        return async function probe() { if (typeof execFile !== "function") return {
            stopped: false, reason: "process_probe_unavailable", processes: [] };
            try { const result = await execFile("/bin/ps", ["-ax", "-o", "pid=,command="]),
                processes = detectOptionMapProcesses(result.stdout, currentPid);
                return { stopped: processes.length === 0, reason: processes.length ?
                    "optionmap_runtime_running" : null, processes,
                    snapshotId: processes.map(item => item.pid).sort((a, b) => a - b).join(",") || "stopped" };
            } catch (error) { return { stopped: false, reason: "process_probe_failed",
                error: error?.message || String(error), processes: [] }; } };
    }
    return Object.freeze({ detectOptionMapProcesses, createMacOsRuntimeProbe });
});
