import { describe, expect, it } from "vitest";

import {
  collectTracedPackages,
  extractTracedPackageName,
} from "./copy-frontend.mjs";

describe("extractTracedPackageName", () => {
  it("extracts unscoped and scoped packages from pnpm hoisted trace paths", () => {
    expect(
      extractTracedPackageName(
        "../node_modules/.pnpm/node_modules/@swc/helpers/_/_interop_require_default.js"
      )
    ).toBe("@swc/helpers");

    expect(
      extractTracedPackageName(
        "../node_modules/.pnpm/node_modules/@next/env/dist/index.js"
      )
    ).toBe("@next/env");

    expect(
      extractTracedPackageName(
        "../node_modules/.pnpm/node_modules/react/index.js"
      )
    ).toBe("react");
  });

  it("ignores non-package or unrelated trace paths", () => {
    expect(extractTracedPackageName("../node_modules/.pnpm/store/v3/file.js")).toBeUndefined();
    expect(extractTracedPackageName("server/app/page.js")).toBeUndefined();
    expect(extractTracedPackageName("../node_modules/.pnpm/node_modules/")).toBeUndefined();
  });
});

describe("collectTracedPackages", () => {
  it("deduplicates packages gathered from multiple trace manifests", () => {
    const packages = collectTracedPackages([
      {
        files: [
          "../node_modules/.pnpm/node_modules/react/index.js",
          "../node_modules/.pnpm/node_modules/@next/env/dist/index.js",
        ],
      },
      {
        files: [
          "../node_modules/.pnpm/node_modules/react/jsx-runtime.js",
          "../node_modules/.pnpm/node_modules/@swc/helpers/_/_interop_require_default.js",
        ],
      },
    ]);

    expect([...packages]).toEqual(["react", "@next/env", "@swc/helpers"]);
  });
});
