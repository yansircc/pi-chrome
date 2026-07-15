import { expect, it } from "@effect/vitest";
import { parsePnpmPackReport, validatePackedFileSet } from "../../scripts/package-artifact.js";
import {
  RELEASE_BUILD_GRAPH,
  validatePiBundleSource,
  validateReleaseBuildGraph,
} from "../../scripts/release-build-graph.js";

it("derives the Pi package entry from the release output graph", () => {
  expect(() => validateReleaseBuildGraph()).not.toThrow();
  expect(RELEASE_BUILD_GRAPH.pi.packageEntry).toBe("./dist/pi/extension.js");
});

it("allows only Node and Pi host imports in the self-contained Pi bundle", () => {
  expect(() =>
    validatePiBundleSource(
      [
        'import { createServer } from "node:http";',
        'import { getAgentDir } from "@earendil-works/pi-coding-agent";',
        "export default () => createServer;",
      ].join("\n"),
      "extension.js",
    ),
  ).not.toThrow();
  expect(() =>
    validatePiBundleSource('import * as Effect from "effect/Effect";', "extension.js"),
  ).toThrow("unbundled runtime imports: effect/Effect");
  expect(() =>
    validatePiBundleSource(
      [
        'export { pipe } from "effect/Function";',
        'const load = () => import("effect/Effect");',
      ].join("\n"),
      "extension.js",
    ),
  ).toThrow("unbundled runtime imports: effect/Effect, effect/Function");
  expect(() =>
    validatePiBundleSource(
      [
        '// import "effect/Effect";',
        'const text = "import(\\\"effect/Effect\\\")";',
        "import.meta.url;",
      ].join("\n"),
      "extension.js",
    ),
  ).not.toThrow();
  expect(() => validatePiBundleSource('require("effect")', "extension.js")).toThrow(
    "CommonJS runtime dependency",
  );
});

it("rejects missing runtime files, source files, undeclared output, and packaged tests", () => {
  expect(() =>
    validatePackedFileSet(
      new Set(["package/package.json"]),
      new Set(["package.json", "dist/pi/extension.js"]),
    ),
  ).toThrow("package/dist/pi/extension.js");

  expect(() =>
    validatePackedFileSet(
      new Set(["package/package.json", "package/test-suite/unit/example.test.ts"]),
      new Set(["package.json"]),
    ),
  ).toThrow("contains test-suite files");

  expect(() =>
    validatePackedFileSet(
      new Set(["package/package.json", "package/src/pi/extension.ts"]),
      new Set(["package.json"]),
    ),
  ).toThrow("source files instead of release artifacts");

  expect(() =>
    validatePackedFileSet(
      new Set([
        "package/package.json",
        "package/dist/.browser-extension.backup-build/manifest.json",
      ]),
      new Set(["package.json"]),
    ),
  ).toThrow("undeclared release artifacts");
});

it("parses the exact pnpm pack artifact report", () => {
  const filename = "/tmp/pi-chrome-0.16.0.tgz";
  const packedFiles = parsePnpmPackReport(
    JSON.stringify({
      name: "pi-chrome",
      version: "0.16.0",
      filename,
      files: [{ path: "package.json" }, { path: "dist/browser-extension/manifest.json" }],
    }),
    { name: "pi-chrome", version: "0.16.0", filename },
  );

  expect(packedFiles).toEqual(
    new Set(["package/package.json", "package/dist/browser-extension/manifest.json"]),
  );
});

it("rejects a mismatched or ambiguous pnpm pack artifact report", () => {
  const expected = {
    name: "pi-chrome",
    version: "0.16.0",
    filename: "/tmp/pi-chrome-0.16.0.tgz",
  };
  const report = {
    name: expected.name,
    version: expected.version,
    filename: "/tmp/other.tgz",
    files: [{ path: "package.json" }],
  };

  expect(() => parsePnpmPackReport(JSON.stringify(report), expected)).toThrow(
    "does not identify the requested package artifact",
  );
  expect(() =>
    parsePnpmPackReport(
      JSON.stringify({
        ...report,
        filename: expected.filename,
        files: [report.files[0], report.files[0]],
      }),
      expected,
    ),
  ).toThrow("repeats file package.json");
});
