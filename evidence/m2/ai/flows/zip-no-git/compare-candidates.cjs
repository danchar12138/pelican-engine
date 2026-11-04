const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const old=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../report/candidate4-engine-after.json'),'utf8')).files;
const current=JSON.parse(fs.readFileSync(path.join(__dirname,'engine-before.json'),'utf8')).files;
const diffs=[...new Set([...Object.keys(old),...Object.keys(current)])].filter(k=>old[k]!==current[k]).map(file=>({file,before:old[file]||null,after:current[file]||null}));
const result={previousSource:'310d38ff51f423ec4d567191b118f47b83d8d3bd586852e8984169f2bd5f3c58',currentSource:'857f76bd1d85de6d0e05b8ce5b08a2009b7d74b5692f38dbda39ed76ca5d44a2',differences:diffs,previousReportUnchanged:true,oldCandidateRejectedForConfirmedEngineDefect:true};
assert(diffs.length>0);fs.writeFileSync(path.join(__dirname,'candidate4-to-5.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
