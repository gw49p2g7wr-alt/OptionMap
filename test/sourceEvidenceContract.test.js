"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Acquisition = require("../js/economicValues/blsCpiAcquisition.js");
const Cpi = require("../js/economicValues/blsCpiFormal.js");
const Fixture = require("./fixtures/economicValues/blsCpiReleaseFixture.js");

const policy = (patch = {}) => Evidence.createSourcePolicy({
  sourceFamily: "economic_values",
  sourceId: "us-bls-cpi-values",
  allowedMediaTypes: ["text/html"],
  allowedEncodings: ["utf-8"],
  maxBytes: 1_000_000,
  ...patch
});
const bytes = value => new TextEncoder().encode(value);
const content = (value = "<html>exact\r\nbytes</html>", patch = {}) => Evidence.createContentObject({
  bytes: bytes(value), mediaType: "text/html", encoding: "UTF8", policy: policy(), ...patch
});
const occurrenceInput = (object, patch = {}) => ({
  sourceFamily: "economic_values",
  sourceId: "us-bls-cpi-values",
  initialUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  fetchedAt: "2026-11-05T00:00:00.000Z",
  httpStatus: 200,
  contentObject: object,
  transportVersion: "bls-fixed-transport-v1",
  publishedAt: "2026-11-05T00:00:00.000Z",
  requestRole: "official_release",
  redirectHops: [],
  sourceDocumentRole: "official_release",
  runId: "run-2026-11-05",
  acquisitionContext: "live_original_acquisition",
  ...patch
});
const occurrence = (object = content(), patch = {}) =>
  Evidence.createAcquisitionOccurrence(occurrenceInput(object, patch), policy());

test("R1-1 exact text bytes retain CRLF and hash without text normalization", () => {
  const original = bytes("A\r\nB\n"), value = Evidence.createContentObject({ bytes: original,
    mediaType: "Text/HTML", encoding: "utf_8", policy: policy() });
  assert.equal(value.sha256, crypto.createHash("sha256").update(original).digest("hex"));
  assert.deepEqual(Evidence.verifyContentBytes(original, value.sha256, original.byteLength), {
    valid: true, reason: null, actualSha256: value.sha256, actualByteLength: original.byteLength });
});

test("R1-2 exact binary bytes have a stable content identity", () => {
  const binaryPolicy = policy({ allowedMediaTypes:
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    allowedEncodings: [], maxBytes: 4096 }), original = Uint8Array.from([0x50, 0x4b, 0, 1, 255]),
    value = Evidence.createContentObject({ bytes: original,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      encoding: null, policy: binaryPolicy });
  assert.equal(value.contentObjectId, `sha256:${Evidence.sha256Bytes(original)}`);
  assert.equal(Evidence.validateContentObject(value), true);
});

test("R1-3 a one-byte change creates a different content identity", () => {
  assert.notEqual(content("abc").contentObjectId, content("abd").contentObjectId);
});

test("R1-4 same bytes and URL fetched later dedupe content but retain separate occurrences", () => {
  const object = content(), first = occurrence(object), second = occurrence(object, {
    fetchedAt: "2026-11-05T01:00:00.000Z", runId: "run-2026-11-05-2" });
  assert.equal(first.contentSha256, second.contentSha256);
  assert.notEqual(first.occurrenceId, second.occurrenceId);
});

test("R1-5 same URL with changed bytes creates a new content object and occurrence", () => {
  const firstContent = content("A"), secondContent = content("B"), first = occurrence(firstContent),
    second = occurrence(secondContent, { fetchedAt: "2026-11-05T01:00:00.000Z",
      runId: "run-2026-11-05-2" });
  assert.notEqual(firstContent.contentObjectId, secondContent.contentObjectId);
  assert.notEqual(first.occurrenceId, second.occurrenceId);
});

test("R1-6 same bytes from a different accepted URL share content but not occurrence", () => {
  const object = content(), first = occurrence(object), second = occurrence(object, {
    initialUrl: "https://www.bls.gov/news.release/cpi.htm",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
    redirectHops: [{ status: 302, url: "https://www.bls.gov/news.release/cpi.nr0.htm" }],
    runId: "redirected-run" });
  assert.equal(first.contentSha256, second.contentSha256);
  assert.notEqual(first.occurrenceId, second.occurrenceId);
});

test("R1-7 changed raw bytes remain distinct even when canonical identity is unchanged", () => {
  const canonicalHash = "a".repeat(64), first = occurrence(content("raw A")),
    second = occurrence(content("raw B"), { fetchedAt: "2026-11-05T01:00:00.000Z", runId: "run-b" }),
    leftRef = Evidence.createSourceEvidenceRef({ state: "available", occurrence: first, policy: policy() }),
    rightRef = Evidence.createSourceEvidenceRef({ state: "available", occurrence: second, policy: policy() }),
    left = Evidence.createParserLineage({ evidenceRef: leftRef, parserId: "bls-cpi-release-values",
      parserVersion: 1, canonicalIdentity: { kind: "canonical_sha256", value: canonicalHash } }),
    right = Evidence.createParserLineage({ evidenceRef: rightRef, parserId: "bls-cpi-release-values",
      parserVersion: 1, canonicalIdentity: { kind: "canonical_sha256", value: canonicalHash } });
  assert.notEqual(left.evidenceRef.contentSha256, right.evidenceRef.contentSha256);
  assert.deepEqual(left.canonicalIdentity, right.canonicalIdentity);
});

test("R1-8 parser upgrade reuses the same raw content identity", () => {
  const acquired = occurrence(), ref = Evidence.createSourceEvidenceRef({ state: "available",
    occurrence: acquired, policy: policy() }), canonicalIdentity = { kind: "fact_sha256", value: "b".repeat(64) },
    v1 = Evidence.createParserLineage({ evidenceRef: ref, parserId: "bls-cpi-release-values",
      parserVersion: 1, canonicalIdentity }),
    v2 = Evidence.createParserLineage({ evidenceRef: ref, parserId: "bls-cpi-release-values",
      parserVersion: 2, canonicalIdentity });
  assert.equal(v1.evidenceRef.contentSha256, v2.evidenceRef.contentSha256);
  assert.notEqual(v1.parserVersion, v2.parserVersion);
});

test("R1-9 MIME mismatch fails closed", () => {
  assert.throws(() => Evidence.createContentObject({ bytes: bytes("{}"), mediaType: "application/json",
    encoding: "utf-8", policy: policy() }), /media_type_not_allowed/);
});

test("R1-10 oversize content fails at policy validation", () => {
  const tiny = policy({ maxBytes: 3 });
  assert.throws(() => Evidence.createContentObject({ bytes: bytes("four"), mediaType: "text/html",
    encoding: "utf-8", policy: tiny }), /content_oversize/);
});

test("R1-11 malformed hash, missing bytes and length mismatch are rejected", () => {
  assert.equal(Evidence.verifyContentBytes(bytes("x"), "bad", 1).reason, "expected_hash_invalid");
  assert.equal(Evidence.verifyContentBytes(null, "a".repeat(64), 1).reason, "content_bytes_missing");
  const value = content("x");
  assert.equal(Evidence.verifyContentBytes(bytes("x"), value.sha256, 2).reason, "byte_length_mismatch");
  assert.equal(Evidence.verifyContentBytes(bytes("y"), value.sha256, 1).reason, "hash_mismatch");
});

test("R1-12 unknown future contract versions fail closed", () => {
  const object = structuredClone(content()); object.contractVersion = "optionmap-source-content-v2";
  const acquired = structuredClone(occurrence()); acquired.contractVersion = "optionmap-source-acquisition-v2";
  const ref = structuredClone(Evidence.createSourceEvidenceRef({ state: "available",
    occurrence: occurrence(), policy: policy() })); ref.contractVersion = "optionmap-source-evidence-ref-v2";
  assert.equal(Evidence.validateContentObject(object), false);
  assert.equal(Evidence.validateAcquisitionOccurrence(acquired, policy()), false);
  assert.equal(Evidence.validateSourceEvidenceRef(ref), false);
});

test("R1-13 secret or arbitrary metadata fields are rejected instead of retained", () => {
  const object = content(), attempted = { ...occurrenceInput(object), headers: { Cookie: "secret" } };
  assert.throws(() => Evidence.createAcquisitionOccurrence(attempted, policy()), /occurrence_fields_invalid/);
  const redirected = occurrenceInput(object, { initialUrl: "https://www.bls.gov/news.release/cpi.htm",
    redirectHops: [{ status: 302, url: "https://www.bls.gov/news.release/cpi.nr0.htm",
      setCookie: "secret" }] });
  assert.throws(() => Evidence.createAcquisitionOccurrence(redirected, policy()),
    /occurrence_metadata_invalid/);
  assert.equal(Evidence.canonicalHttpsUrl("https://example.test/data?api_key=secret"), null);
  assert.equal(Evidence.canonicalHttpsUrl("file:///Users/example/private.html"), null);
});

test("R1-14 pre-activation and not-applicable domain states need no fabricated evidence", () => {
  const unavailable = Evidence.createSourceEvidenceRef({ state: "unavailable",
    sourceFamily: "economic_values", sourceId: "us-bls-cpi-values", reason: "pre_activation" }),
    notApplicable = Evidence.createSourceEvidenceRef({ state: "not_applicable" });
  assert.deepEqual([unavailable.state, unavailable.contentSha256, unavailable.occurrenceId],
    ["unavailable", null, null]);
  assert.deepEqual([notApplicable.state, notApplicable.sourceFamily], ["not_applicable", null]);
});

test("R1-15 historical archive acquisition is distinct from original live acquisition", () => {
  const object = content(), live = occurrence(object), archive = occurrence(object, {
    fetchedAt: "2027-01-01T00:00:00.000Z", runId: "archive-run",
    acquisitionContext: "historical_archive_fetch" });
  assert.equal(archive.acquisitionContext, "historical_archive_fetch");
  assert.equal(live.contentSha256, archive.contentSha256);
  assert.notEqual(live.occurrenceId, archive.occurrenceId);
});

test("R1-16 identical occurrence facts produce a deterministic occurrence ID", () => {
  const object = content(), input = occurrenceInput(object), left =
    Evidence.createAcquisitionOccurrence(input, policy()), right =
    Evidence.createAcquisitionOccurrence(structuredClone(input), policy());
  assert.equal(left.occurrenceId, right.occurrenceId);
  assert.equal(Evidence.validateAcquisitionOccurrence(left, policy()), true);
});

test("R1-17 US CPI source-document fields bind without changing Economic Values", async () => {
  const html = Fixture.html({ releaseDate: "2026-10-14" }), fetchImpl = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    acquired = await Acquisition.createBlsCpiAcquisition({ fetchImpl,
      now: () => new Date("2026-10-14T13:31:00.000Z") }).acquire({ releaseDate: "2026-10-14" }),
    candidate = Cpi.createAcceptedCandidate({ acquisition: acquired,
      acceptedAt: "2026-10-14T13:32:00.000Z", calendarEventKey: null }), cpiPolicy = policy({
      maxBytes: Math.max(candidate.document.byteCount, 1) }), raw = Evidence.createContentObject({
      bytes: acquired.document.parserInput, mediaType: candidate.document.mime,
      encoding: "utf-8", policy: cpiPolicy }), acquiredOccurrence =
    Evidence.createAcquisitionOccurrence({
      sourceFamily: "economic_values", sourceId: candidate.sourceId,
      initialUrl: candidate.document.sourceUrl, sourceUrl: candidate.document.finalUrl,
      fetchedAt: candidate.release.fetchedAt, httpStatus: candidate.document.httpMetadata.httpStatus,
      contentObject: raw, transportVersion: "bls-fixed-archive-v1",
      publishedAt: candidate.release.publishedAt, requestRole: "official_release", redirectHops: [],
      sourceDocumentRole: candidate.document.role, runId: candidate.runId,
      acquisitionContext: "live_original_acquisition" }, cpiPolicy), ref =
    Evidence.createSourceEvidenceRef({ state: "available", occurrence: acquiredOccurrence,
      policy: cpiPolicy }), lineage = Evidence.createParserLineage({ evidenceRef: ref,
      parserId: candidate.document.parserId, parserVersion: candidate.document.parserVersion,
      canonicalIdentity: { kind: "revision_key", value: candidate.values[0].revisionKey } });
  assert.equal(raw.sha256, candidate.document.rawContentHash);
  assert.equal(raw.byteLength, candidate.document.byteCount);
  assert.equal(lineage.parserId, candidate.document.parserId);
  assert.equal(lineage.canonicalIdentity.value, candidate.values[0].revisionKey);
});
