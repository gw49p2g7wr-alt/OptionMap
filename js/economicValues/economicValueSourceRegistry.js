"use strict";

const Canonical = require("./economicValueCanonical.js");
const Cpi = require("./blsCpiFormal.js");
const Employment = require("./blsEmploymentFormal.js");

const CONTRACTS = Object.freeze([Cpi, Employment]);
const get = sourceId => CONTRACTS.find(contract => contract.SOURCE_ID === sourceId) || null;
const definitionContract = definition => CONTRACTS.find(contract => contract.validateDefinition(definition)) || null;
const validateDefinition = definition => !!definitionContract(definition);
function validateValue(value, definitions) {
  const definition = definitions.find(item => item.seriesDefinitionKey === value.seriesDefinitionKey),
    contract = definition && definitionContract(definition);
  return !!contract && contract.validateValue(value, definitions);
}

module.exports = Canonical.freeze({ CONTRACTS, get, definitionContract, validateDefinition, validateValue });
