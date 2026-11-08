import { graphicsLaunchArguments } from "./browser-session.ts";
import { chromium } from "playwright";
const browser = await chromium.launch({
  headless: false,
  args: [...graphicsLaunchArguments(), "--disable-background-timer-throttling"],
});
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:4173").catch(() => {});
  const result = await page.evaluate(async () => {
    if (!navigator.gpu) return { available: false };
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) return { available: false, stage: "adapter" };
    return {
      available: true,
      info: {
        ...adapter.info,
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
        isFallbackAdapter: adapter.info.isFallbackAdapter,
      },
      features: [...adapter.features],
    };
  });
  console.log(JSON.stringify(result));
  const cdp = await browser.newBrowserCDPSession();
  const info = await cdp.send("SystemInfo.getInfo");
  console.log(JSON.stringify(info.gpu));
} finally {
  await browser.close();
}
