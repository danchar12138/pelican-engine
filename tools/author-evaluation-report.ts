import { diagnoseRendering, type RenderDiagnosticInput } from "../packages/sdk/src/index.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AuthorCommandRecord {
  started: number;
  ended: number;
  args: string[];
  exitCode: number | null;
  status?: string;
  stdoutBytes: number;
  stderrBytes: number;
  batchOperations?: number | null;
  batchCompletedOperations?: number | null;
}
const fail = (detail: string): never => {
  throw new Error(`TC_AUTHOR_EVALUATION: ${detail}`);
};

/** Derive check/query metrics from recorded commands, not from the model's claimed score. */
export function summarizeAuthorCommands(
  workspace: string,
  tasks: readonly string[],
  records: readonly AuthorCommandRecord[],
  host?: {kind:"external-ai";tokenUsage:number|null;elapsedWallMs?:number;tasks:{id:string;attempts:{passed:boolean;state:boolean;interaction:boolean;visual:boolean|null;evidence:string[]}[]}[]},
) {
  if (
    new Set(tasks).size !== tasks.length ||
    tasks.some((id) => !/^[a-z0-9-]+$/.test(id))
  )
    fail("Expected unique task IDs.");
  for (const [index, record] of records.entries()) {
    if (
      !record ||
      !Array.isArray(record.args) ||
      record.args.some((arg) => typeof arg !== "string") ||
      ![
        record.started,
        record.ended,
        record.stdoutBytes,
        record.stderrBytes,
      ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      record.ended < record.started ||
      [record.batchOperations,record.batchCompletedOperations].some(value=>value!=null&&(!Number.isSafeInteger(value)||value<0||value>32)) ||
      (record.exitCode !== null && !Number.isInteger(record.exitCode))
    )
      fail(`Malformed command record ${index + 1}; preserve the original log.`);
  }
  const success = (record: AuthorCommandRecord) =>
    record.exitCode === 0 && record.status === "succeeded";
  const query = (record: AuthorCommandRecord) =>
    ["guide", "api", "capabilities", "recipe", "help", "--help", "-h"].includes(record.args[0]);
  const attributed = (record: AuthorCommandRecord, id: string) => {
    const index = record.args.indexOf("--project");
    if (index < 0 || !record.args[index + 1]) return false;
    const relative = path.relative(
      path.resolve(workspace),
      path.resolve(workspace, record.args[index + 1]),
    );
    return !path.isAbsolute(relative) && relative.split(path.sep)[0] === id;
  };
  if(host && (host.kind!=="external-ai" || (host.tokenUsage!==null && (!Number.isSafeInteger(host.tokenUsage)||host.tokenUsage<0))))fail("Invalid host token accounting.");
  if(host) {
    if(!Array.isArray(host.tasks)||new Set(host.tasks.map(t=>t.id)).size!==host.tasks.length||host.tasks.some(t=>!tasks.includes(t.id)||!Array.isArray(t.attempts)||t.attempts.some(a=>!a||typeof a.passed!=="boolean"||typeof a.state!=="boolean"||typeof a.interaction!=="boolean"||(a.visual!==null&&typeof a.visual!=="boolean")||!Array.isArray(a.evidence)||a.evidence.some(p=>typeof p!=="string"||!p))))fail("Malformed host acceptance records.");
    if(host.elapsedWallMs!==undefined&&(!Number.isFinite(host.elapsedWallMs)||host.elapsedWallMs<0))fail("Invalid host elapsed time.");
  }
  const taskReports = tasks.map((id) => {
    const commands = records.filter((record) => attributed(record, id));
    const checks = commands.filter((record) => record.args[0] === "check");
    const attempts=host?.tasks.find(t=>t.id===id)?.attempts;
    const full=(a:NonNullable<typeof attempts>[number])=>a.passed && a.state && a.interaction && a.visual!==false && Array.isArray(a.evidence) && a.evidence.length>0;
    return {
      id,
      cliCalls:commands.length,
      batchOperations:commands.some(c=>c.args[0]==="batch"&&c.batchOperations==null)?null:commands.reduce((n,c)=>n+(c.batchOperations??0),0),
      batchCompletedOperations:commands.some(c=>c.args[0]==="batch"&&c.batchCompletedOperations==null)?null:commands.reduce((n,c)=>n+(c.batchCompletedOperations??0),0),
      queryBytes:commands.filter(query).reduce((n,c)=>n+c.stdoutBytes,0),
      firstFullAcceptance:attempts?.length ? full(attempts[0]) : null,
      acceptanceAttempts:attempts?.length??null,
      acceptanceRetries:attempts?.length ? attempts.length-1 : null,
      firstCheckSucceeded: checks.length ? success(checks[0]) : null,
      checks: checks.length,
      rechecks: Math.max(0, checks.length - 1),
      failedChecks: checks.filter((record) => !success(record)).length,
      successfulBuilds: commands.filter(
        (record) => record.args[0] === "build" && success(record),
      ).length,
      commandWallMs: commands.reduce(
        (sum, record) => sum + record.ended - record.started,
        0,
      ),
    };
  });
  const queries = records.filter(query),
    attempted = taskReports.filter((task) => task.firstCheckSucceeded !== null);
  return {
    format: "pelican.author-command-report",
    version: 1,
    commands: records.length,
    evaluationKind:host?"external-ai-with-host-evidence":"command-regression-only",
    tokenUsage:host?.tokenUsage??null,
    elapsedWallMs:host?.elapsedWallMs??null,
    targets:{status:"unverified",firstCompleteAcceptanceRate:.7,averageCliCalls:8,averageTokens:20000,faultFactCoverage:.8},
    firstFullAcceptance:{attempted:taskReports.filter(t=>t.firstFullAcceptance!==null).length,rate:taskReports.some(t=>t.firstFullAcceptance!==null)?taskReports.filter(t=>t.firstFullAcceptance===true).length/taskReports.filter(t=>t.firstFullAcceptance!==null).length:null},
    query: {
      count: queries.length,
      failed: queries.filter((record) => !success(record)).length,
      stdoutBytes: queries.reduce((sum, record) => sum + record.stdoutBytes, 0),
      stderrBytes: queries.reduce((sum, record) => sum + record.stderrBytes, 0),
      wallMs: queries.reduce(
        (sum, record) => sum + record.ended - record.started,
        0,
      ),
    },
    tasks: taskReports,
    firstCheck: {
      attemptedTasks: attempted.length,
      succeeded: attempted.filter((task) => task.firstCheckSucceeded).length,
      rate: attempted.length
        ? attempted.filter((task) => task.firstCheckSucceeded).length /
          attempted.length
        : null,
    },
    limits: [
      "First-check success is not first-attempt task completion or browser acceptance.",
      "Rechecks are measured; code repairs and infrastructure retries require the preserved author timeline.",
      "Command wall time excludes author thinking/editing and is not model compute time. Query bytes are UTF-8 output bytes, not token counts.",
      "Queries without --project contribute to total cost but are not attributed to an individual task. No missing runtime evidence is treated as a pass.",
    ],
  };
}

export async function readAuthorCommandReport(workspace: string) {
  const task = JSON.parse(
    await readFile(path.join(workspace, "TASK.json"), "utf8"),
  );
  if (
    !Array.isArray(task.tasks) ||
    task.tasks.some(
      (item: unknown) =>
        !item ||
        typeof item !== "object" ||
        !("id" in item) ||
        typeof item.id !== "string",
    )
  )
    fail("TASK.json must declare task IDs.");
  const text = await readFile(path.join(workspace, "commands.jsonl"), "utf8");
  const records = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as AuthorCommandRecord;
      } catch {
        return fail(
          `Invalid commands.jsonl line ${index + 1}; do not discard failed evidence.`,
        );
      }
    });
  return {
    ...summarizeAuthorCommands(
      workspace,
      task.tasks.map((item: { id: string }) => item.id),
      records,
      await readFile(path.join(workspace,"host-evaluation.json"),"utf8").then(text=>JSON.parse(text)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;return undefined;}),
    ),
    engineVersion: task.engineVersion,
    coldStart:task.coldStart??null,
    environment:task.environment??null,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--workspace" || !args[1])
    fail(
      "Usage: npm run evaluate:author:report -- --workspace <evaluation-directory>",
    );
  readAuthorCommandReport(path.resolve(args[1]))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}

/** Fixed observation fixtures. Unit regression coverage is not external-AI troubleshooting success. */
export const authorFaultCases: readonly {id:string;input:RenderDiagnosticInput;expected:string[]}[] = [
 {id:"wall-budget",input:{mode:"raster",metrics:[{wallMs:50}]},expected:["TC_RENDER_FRAME_BUDGET"]},
 {id:"history-reset",input:{rendering:{surface:{samples:32,temporal:{lastReset:true,resetReasons:["mode"]}}}},expected:["TC_RENDER_HISTORY_INVALIDATED"]},
 {id:"capture-cost",input:{rendering:{surface:{samples:32,captureMs:10}}},expected:["TC_RENDER_CONTENT_COST"]},
 {id:"upload-cost",input:{rendering:{surface:{samples:32,uploadMs:10}}},expected:["TC_RENDER_CONTENT_COST"]},
 {id:"upload-volume",input:{rendering:{surface:{samples:32,uploadBytes:2097152}}},expected:["TC_RENDER_UPLOAD_VOLUME"]},
 {id:"low-accumulation",input:{mode:"path",rendering:{surface:{samples:1}}},expected:["TC_RENDER_LOW_ACCUMULATION"]},
 {id:"storage-preflight",input:{mode:"path",viewport:{width:4096,height:2160}},expected:["TC_RENDER_STORAGE_PREFLIGHT"]},
 {id:"duplicate-assets",input:{mode:"raster",assets:[{id:"a",hash:"same"},{id:"b",hash:"same"}]},expected:["TC_ASSET_DUPLICATE_CONTENT"]},
 {id:"healthy-raster",input:{mode:"raster",metrics:[{wallMs:5}]},expected:[]},
 {id:"healthy-path",input:{mode:"path",viewport:{width:640,height:360},rendering:{surface:{samples:64,captureMs:1,uploadMs:1}}},expected:[]}
];
export function evaluateFaultFacts() {
 const cases=authorFaultCases.map(item=>{const codes=diagnoseRendering(item.input).findings.map(f=>f.code);return {id:item.id,expected:item.expected,observed:codes,covered:item.expected.every(code=>codes.includes(code)),falsePositives:codes.filter(code=>!item.expected.includes(code))};});
 const faults=cases.filter(c=>c.expected.length),healthy=cases.filter(c=>!c.expected.length);
 return {kind:"prewritten-observation-regression",cases,coverage:faults.filter(c=>c.covered).length/faults.length,healthyCases:healthy.length,healthyFalsePositives:healthy.reduce((n,c)=>n+c.falsePositives.length,0),externalAiFaultCoverage:null};
}
