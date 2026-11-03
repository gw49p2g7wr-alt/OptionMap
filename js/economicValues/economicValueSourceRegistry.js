"use strict";

const Canonical = require("./economicValueCanonical.js");
const Cpi = require("./blsCpiFormal.js");
const Employment = require("./blsEmploymentFormal.js");
const JapanCpi = require("./jpCpiFormal.js");
const Pce = require("./beaPceFormal.js");

const CONTRACTS = Object.freeze([Cpi, Employment, JapanCpi, Pce]);
const get = sourceId => CONTRACTS.find(contract => contract.SOURCE_ID === sourceId) || null;
const definitionContract = definition => CONTRACTS.find(contract => contract.validateDefinition(definition)) || null;
const validateDefinition = definition => !!definitionContract(definition);
const seriesCount = contract => contract.SERIES_COUNT || contract.SERIES.length;
const definitionsForSource = (definitions, sourceId) => {
  const contract = get(sourceId);
  return contract ? definitions.filter(definition => contract.validateDefinition(definition)) : [];
};
const validateDefinitionSet = (sourceId, definitions) => {
  const contract = get(sourceId);
  return !!contract && definitions.length === seriesCount(contract) &&
    definitions.every(definition => contract.validateDefinition(definition)) &&
    new Set(definitions.map(definition => definition.seriesDefinitionKey)).size === definitions.length &&
    (typeof contract.validateDefinitionSet !== "function" || contract.validateDefinitionSet(definitions));
};
function validateValue(value, definitions) {
  const definition = definitions.find(item => item.seriesDefinitionKey === value.seriesDefinitionKey),
    contract = definition && definitionContract(definition);
  return !!contract && contract.validateValue(value, definitions);
}

module.exports = Canonical.freeze({ CONTRACTS, get, definitionContract, validateDefinition, validateValue,
  seriesCount, definitionsForSource, validateDefinitionSet });
