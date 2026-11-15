"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, safeStorage } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const Rewrap = require(path.join(ROOT, "js/productionAuthorityRewrap.js"));
const QriStore = require(path.join(ROOT, "js/qriProductionAuthority.js"));
const ParticipantStore = require(path.join(ROOT, "js/participantProductionAuthority.js"));
const WeeklyStore = require(path.join(ROOT, "js/weeklyProductionAuthority.js"));

const mode = process.argv.at(-2), profileArgument = process.argv.at(-1);
if (!["seed", "migrate"].includes(mode) || typeof profileArgument !== "string") process.exit(2);
const profile = fs.realpathSync(profileArgument);
app.setName(mode === "seed" ? Rewrap.LEGACY_IDENTITY : Rewrap.CANONICAL_IDENTITY);
app.setPath("userData", profile);

const protector = () => Object.freeze({
  protect: bytes => safeStorage.encryptString(Buffer.from(bytes).toString("base64")),
  unprotect: bytes => Buffer.from(safeStorage.decryptString(bytes), "base64")
});
const create = (Store, byte) => Store.createProductionAuthority({
  getUserDataPath: () => profile, protector: protector(), randomBytes: size => Buffer.alloc(size, byte)
});

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("native_safe_storage_unavailable");
  if (mode === "seed") {
    const qri = create(QriStore, 17), participants = create(ParticipantStore, 29),
      integrity = "a".repeat(64), artifact = {
        integrity, qriSignature: qri.authority.sign("legacy-continuity", integrity),
        participantsSignature: participants.authority.sign("legacy-continuity", integrity)
      };
    fs.writeFileSync(path.join(profile, "legacy-artifact.json"), JSON.stringify(artifact),
      { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ seeded: true })}\n`);
    return;
  }
  const weekly = create(WeeklyStore, 41), weeklyFile = path.join(profile, WeeklyStore.FILE_NAME),
    weeklyBefore = crypto.createHash("sha256").update(fs.readFileSync(weeklyFile)).digest("hex"),
    appFacade = Object.freeze({ isPackaged: false, getAppPath: () => ROOT,
      getPath: name => app.getPath(name) }), env = { ...process.env },
    migrate = domain => Rewrap.migrateAuthorityRecord({ domain, profile,
      protector: protector(), legacyDecrypt: selected => Rewrap.invokeLegacyHelper({
        app: appFacade, domain: selected, profile, env }) });
  const qriResult = migrate("qri"), participantResult = migrate("participants"),
    qri = create(QriStore, 99), participants = create(ParticipantStore, 99),
    artifact = JSON.parse(fs.readFileSync(path.join(profile, "legacy-artifact.json"), "utf8")),
    secondQri = migrate("qri"), secondParticipants = migrate("participants"),
    weeklyAfter = crypto.createHash("sha256").update(fs.readFileSync(weeklyFile)).digest("hex");
  process.stdout.write(`${JSON.stringify({ qriResult, participantResult,
    qriSignatureValid: qri.authority.verify("legacy-continuity", artifact.integrity,
      artifact.qriSignature),
    participantsSignatureValid: participants.authority.verify("legacy-continuity",
      artifact.integrity, artifact.participantsSignature),
    secondQri, secondParticipants, weeklyKeyId: weekly.keyId,
    weeklyUnchanged: weeklyBefore === weeklyAfter })}\n`);
}).catch(failure => {
  process.stderr.write(`${failure?.code || failure?.message || failure}\n`);
  process.exitCode = 1;
}).finally(() => app.quit());
