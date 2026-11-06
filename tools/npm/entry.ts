import { fileURLToPath } from "node:url";

// Keep the executable boundary free of third-party imports so installation errors
// have the same machine-readable protocol as compiler and command failures.
try {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const { installedDiagnostics } = await import("./layout.ts");
  const diagnostics = await installedDiagnostics(root);
  if (diagnostics.length) {
    console.log(
      JSON.stringify(
        {
          protocolVersion: "0.1.0",
          taskId: "installation",
          status: "failed",
          diagnostics,
          artifacts: [],
          data: null,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else await import("../cli.ts");
} catch (error) {
  console.log(
    JSON.stringify(
      {
        protocolVersion: "0.1.0",
        taskId: "installation",
        status: "failed",
        diagnostics: [
          {
            code: "TC_DISTRIBUTION_INSTALLATION",
            severity: "error",
            message: String(error),
            remediation:
              "Reinstall the exact pelican-engine package and its dependencies; do not copy partial node_modules directories.",
          },
        ],
        artifacts: [],
        data: null,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
