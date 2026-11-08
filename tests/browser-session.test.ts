import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright";
import {
  AutomationError,
  automationLaunchOptions,
  automationURL,
  waitForEngine,
  withAutomationDeadline,
} from "../tools/browser-session.ts";

type Probe = (source: string, arg: unknown, options: unknown) => unknown;
function fixture(probe: Probe = () => ({ state: "ready" })) {
  let disposals = 0;
  const calls: {
    source: string;
    sourceKind: string;
    arg: unknown;
    options: unknown;
  }[] = [];
  const page = {
    async waitForFunction(source: unknown, arg: unknown, options: unknown) {
      calls.push({
        source: String(source),
        sourceKind: typeof source,
        arg,
        options,
      });
      const status = await probe(String(source), arg, options);
      return {
        jsonValue: async () => status,
        dispose: async () => {
          disposals++;
        },
      };
    },
  } as unknown as Pick<Page, "waitForFunction">;
  return { page, calls, disposals: () => disposals };
}
function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof AutomationError && error.code === code;
}

test("launch options keep headed D3D11 with only the requested background safeguards", () => {
  const options = automationLaunchOptions(30_000, "win32");
  assert.equal(options.headless, false);
  assert.equal(options.timeout, 30_000);
  assert.deepEqual(options.args, [
    "--use-angle=d3d11",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
  ]);
  assert.doesNotMatch(
    options.args!.join(" "),
    /unsafe|swiftshader|disable-gpu|ignore-gpu/,
  );
  options.args!.push("changed");
  assert.ok(!automationLaunchOptions().args!.includes("changed"));
  assert.equal(automationLaunchOptions(1234).timeout, 1234);
});

test("automation URL preserves nested paths, other queries and fragments and is idempotent", () => {
  const url =
    "http://127.0.0.1:4173/nested/game/?asset=a%20b&automation=0#test";
  const actual = new URL(automationURL(url));
  assert.equal(actual.pathname, "/nested/game/");
  assert.equal(actual.searchParams.get("asset"), "a b");
  assert.deepEqual(actual.searchParams.getAll("automation"), ["1"]);
  assert.equal(actual.hash, "#test");
  assert.equal(automationURL(actual.href), actual.href);
});

test("engine wait uses explicit numeric polling and the requested bounded timeout", async () => {
  const f = fixture();
  await waitForEngine(f.page, 2345);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].options, { polling: 100, timeout: 2345 });
  assert.deepEqual(f.calls[0].arg, { production: false });
  assert.equal(typeof f.calls[0].source, "string");
  assert.equal(f.calls[0].sourceKind, "function");
  assert.equal(f.disposals(), 1);
});

test("production wait does not require or introduce a development control hook", async () => {
  const f = fixture();
  await waitForEngine(f.page, 1000, { production: true });
  assert.deepEqual(f.calls[0].arg, { production: true });
});

test("probe works without RAF, focus or input and requires ready plus the command protocol", async () => {
  const f = fixture((source, arg) => {
    const document = {
      documentElement: { dataset: { pelicanReady: "false" } },
    };
    const environment = {
      document,
      __pelican: { command: () => undefined },
      requestAnimationFrame: () => {
        throw new Error("RAF must not be used");
      },
    };
    const probe = runInNewContext(`(${source})`, environment) as (
      arg: unknown,
    ) => unknown;
    assert.equal(probe(arg), false);
    document.documentElement.dataset.pelicanReady = "true";
    const ready = probe(arg);
    assert.equal(JSON.stringify(ready), '{"state":"ready"}');
    (environment.__pelican as { command?: unknown }).command = undefined;
    assert.equal(probe(arg), false);
    assert.equal(
      JSON.stringify(probe({ production: true })),
      '{"state":"ready"}',
    );
    return ready;
  });
  await waitForEngine(f.page, 1000);
});

test("probe observes engine failure before ready even if a stale command hook exists", async () => {
  const f = fixture((source, arg) =>
    runInNewContext(`(${source})`, {
      document: { documentElement: { dataset: { pelicanReady: "true" } } },
      __pelican: { command: () => undefined },
      __pelicanFailure: "TC_GPU_TIMEOUT: device initialization timed out",
    })(arg),
  );
  await assert.rejects(waitForEngine(f.page, 1000), (error: unknown) => {
    assert.ok(error instanceof AutomationError);
    assert.equal(error.code, "TC_AUTOMATION_BOOT_FAILED");
    assert.match(error.message, /TC_GPU_TIMEOUT/);
    return true;
  });
  assert.equal(f.disposals(), 1);
});

for (const status of [
  null,
  undefined,
  false,
  1,
  "ready",
  {},
  { state: "waiting" },
]) {
  test(`malformed readiness result is rejected: ${JSON.stringify(status)}`, async () => {
    const f = fixture(() => status);
    await assert.rejects(
      waitForEngine(f.page, 1000),
      hasCode("TC_AUTOMATION_READY_PROTOCOL"),
    );
    assert.equal(f.disposals(), 1);
  });
}

test(
  "a permanently unresolved page wait hits a real Node deadline and owner cleanup",
  { timeout: 2000 },
  async () => {
    const f = fixture(() => new Promise<never>(() => undefined));
    let ownerClosed = false;
    const start = performance.now();
    await assert.rejects(
      (async () => {
        try {
          await waitForEngine(f.page, 35);
        } finally {
          ownerClosed = true;
        }
      })(),
      hasCode("TC_AUTOMATION_TIMEOUT"),
    );
    assert.ok(ownerClosed);
    assert.ok(performance.now() - start < 1500);
    assert.equal(f.disposals(), 0);
  },
);

for (const phase of ["jsonValue", "dispose"] as const) {
  test(
    `Node deadline also bounds a frozen handle ${phase}`,
    { timeout: 2000 },
    async () => {
      const page = {
        waitForFunction: async () => ({
          jsonValue: () =>
            phase === "jsonValue"
              ? new Promise<never>(() => undefined)
              : Promise.resolve({ state: "ready" }),
          dispose: () =>
            phase === "dispose"
              ? new Promise<never>(() => undefined)
              : Promise.resolve(),
        }),
      } as unknown as Pick<Page, "waitForFunction">;
      await assert.rejects(
        waitForEngine(page, 35),
        hasCode("TC_AUTOMATION_TIMEOUT"),
      );
    },
  );
}

test("Playwright timeout is normalized with cause while other transport errors stay distinct", async () => {
  for (const name of ["TimeoutError", "Error"]) {
    const cause = new Error("transport stopped");
    cause.name = name;
    const f = fixture(() => {
      throw cause;
    });
    await assert.rejects(waitForEngine(f.page, 1000), (error: unknown) => {
      assert.ok(error instanceof AutomationError);
      assert.equal(
        error.code,
        name === "TimeoutError"
          ? "TC_AUTOMATION_TIMEOUT"
          : "TC_AUTOMATION_WAIT_FAILED",
      );
      assert.equal(error.cause, cause);
      return true;
    });
  }
});

test("deadline returns successful values, preserves errors, and catches synchronous failures", async () => {
  assert.equal(await withAutomationDeadline(async () => 42, 1000), 42);
  const cause = new Error("failure");
  await assert.rejects(
    withAutomationDeadline(async () => {
      throw cause;
    }, 1000),
    (error) => error === cause,
  );
  await assert.rejects(
    withAutomationDeadline(() => {
      throw cause;
    }, 1000),
    (error) => error === cause,
  );
});

test(
  "late rejection after the Node deadline is observed without an unhandled rejection",
  { timeout: 2000 },
  async () => {
    let reject!: (reason: Error) => void;
    const promise = new Promise<never>((_, fail) => {
      reject = fail;
    });
    await assert.rejects(
      withAutomationDeadline(() => promise, 25),
      hasCode("TC_AUTOMATION_TIMEOUT"),
    );
    reject(new Error("late renderer rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  },
);

test("invalid deadlines reject before launching or probing", async () => {
  for (const timeout of [0, -1, NaN, Infinity, 0.5, 120_001]) {
    assert.throws(
      () => automationLaunchOptions(timeout),
      hasCode("TC_AUTOMATION_TIMEOUT_RANGE"),
    );
    const f = fixture();
    await assert.rejects(
      waitForEngine(f.page, timeout),
      hasCode("TC_AUTOMATION_TIMEOUT_RANGE"),
    );
    await assert.rejects(
      withAutomationDeadline(async () => 1, timeout),
      hasCode("TC_AUTOMATION_TIMEOUT_RANGE"),
    );
    assert.equal(f.calls.length, 0);
  }
});

 test("non-Windows automation leaves the graphics backend to Chromium", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const args = automationLaunchOptions(30000, platform).args!;
    assert.ok(!args.some(arg => /d3d|WinOcclusion/.test(arg)));
    assert.ok(!args.some(arg => /swiftshader|disable-gpu/.test(arg)));
  }
});
