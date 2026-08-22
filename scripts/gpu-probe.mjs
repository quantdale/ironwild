// GPU capability probe: which Chromium launch config gets hardware WebGL?
// Usage: node scripts/gpu-probe.mjs  (documents the renderer each E2E mode
// will see; IW_E2E_GPU=1 relies on the ANGLE/D3D11 result below)
import { chromium } from "@playwright/test";

const configs = [
  { name: "headless-default", opts: { headless: true } },
  {
    name: "headless-angle-d3d11",
    opts: {
      headless: true,
      args: [
        "--use-angle=d3d11",
        "--enable-unsafe-swiftshader",
        "--use-gl=angle",
      ],
    },
  },
  {
    name: "headed",
    opts: { headless: false, args: ["--window-position=2000,2000"] },
  },
];

for (const c of configs) {
  let browser;
  try {
    browser = await chromium.launch(c.opts);
    const page = await browser.newPage();
    const info = await page.evaluate(() => {
      const cv = document.createElement("canvas");
      const gl = cv.getContext("webgl2") || cv.getContext("webgl");
      if (!gl) return { webgl: false };
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        webgl: true,
        version: gl.getParameter(gl.VERSION),
        renderer: dbg
          ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        vendor: dbg
          ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR),
        sw:
          document.documentElement.textContent === null ? undefined : undefined,
        maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      };
    });
    console.log(`[${c.name}]`, JSON.stringify(info));
  } catch (e) {
    console.log(`[${c.name}] FAILED: ${String(e).split("\n")[0]}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}
