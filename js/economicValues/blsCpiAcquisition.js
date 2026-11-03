"use strict";

const Canonical = require("./economicValueCanonical.js");
const Shared = require("./blsFixedArchiveAcquisition.js");

const archivePath = releaseDate => Shared.archivePath("cpi", releaseDate);
const urlFor = releaseDate => Shared.urlFor("cpi", releaseDate);
const validateUrl = (value, releaseDate) => Shared.validateUrl("cpi", value, releaseDate);
const createBlsCpiAcquisition = options => Shared.createFixedArchiveAcquisition({ routeId: "cpi", ...options });

module.exports = Canonical.freeze({ HOST: Shared.HOST, MAX_REDIRECTS: Shared.MAX_REDIRECTS,
  MAX_BYTES: Shared.MAX_BYTES, TIMEOUT_MS: Shared.TIMEOUT_MS, archivePath,
  urlFor, validateUrl, createBlsCpiAcquisition });
