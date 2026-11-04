const fs=require("node:fs"),cp=require("node:child_process");
const patch=fs.readFileSync(0,"utf8").replace(/^\uFEFF/,"");
const r=cp.spawnSync("C:/Users/60459/.vscode/extensions/openai.chatgpt-26.1021.22027-win32-x64/bin/windows-x86_64/codex.exe",["--codex-run-as-apply-patch",patch],{encoding:"utf8"});
process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");process.exit(r.status??1);
