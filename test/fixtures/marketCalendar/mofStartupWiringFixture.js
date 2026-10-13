"use strict";
const fs=require("node:fs"),path=require("node:path"),File=require("../../../js/marketCalendarHistory/writerSafetyFileSchema.js");
const Atomic=require("../../../js/marketCalendarHistory/writerSafetyAtomicCore.js"),Gen=require("../../../js/marketCalendarRuntime/writerSafetyGenerationReadOnly.js");
// Synthetic historical pair only; never reads a production profile.
function seedHistorical(profile,r){
  const save=(d,r)=>{fs.mkdirSync(d,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(d,Atomic.NAMES.state),JSON.stringify(r),{mode:0o600});
    fs.writeFileSync(path.join(d,Atomic.NAMES.checkpoint),JSON.stringify(File.seal({schemaVersion:r.schemaVersion,sequence:r.safety.sequence,stateChecksum:r.checksum})),{mode:0o600});};
  save(path.join(profile,Atomic.DIRECTORY),r.historicalRecord);
  const generation=`controlled-${r.safety.sequence}`,dir=path.join(profile,Gen.DIRECTORY);
  save(path.join(dir,generation,Atomic.DIRECTORY),r);
  fs.writeFileSync(path.join(dir,"selection.json"),JSON.stringify(File.seal({schemaVersion:1,generation,sequence:r.safety.sequence,stateChecksum:r.checksum})),{mode:0o600});
}
module.exports=Object.freeze({seedHistorical});
