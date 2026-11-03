"use strict";

const Canonical = require("./economicValueCanonical.js");
const Shared = require("./blsFixedArchiveAcquisition.js");

const archivePath = releaseDate => Shared.archivePath("employment_situation", releaseDate);
const urlFor = releaseDate => Shared.urlFor("employment_situation", releaseDate);
const validateUrl = (value, releaseDate) => Shared.validateUrl("employment_situation", value, releaseDate);
const createBlsEmploymentAcquisition = options => Shared.createFixedArchiveAcquisition({
  routeId: "employment_situation", ...options });

module.exports = Canonical.freeze({ HOST: Shared.HOST, MAX_REDIRECTS: Shared.MAX_REDIRECTS,
  MAX_BYTES: Shared.MAX_BYTES, TIMEOUT_MS: Shared.TIMEOUT_MS, archivePath, urlFor, validateUrl,
  createBlsEmploymentAcquisition });
