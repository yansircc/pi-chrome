import { expect, it } from "vite-plus/test";
import packageJson from "../../package.json" with { type: "json" };
import { requireReleaseTag } from "../../scripts/release-tag.ts";
import viteConfig from "../../vite.config.js";

type Task = {
  readonly command: string | ReadonlyArray<string>;
};

const tasks = (
  viteConfig as {
    readonly run: { readonly tasks: Readonly<Record<string, Task>> };
  }
).run.tasks;

const lintOptions = (
  viteConfig as {
    readonly lint: {
      readonly options: { readonly typeAware: boolean; readonly typeCheck: boolean };
    };
  }
).lint.options;

it("requires verification and a real connector smoke before publishing", () => {
  expect(packageJson.files).toContain("dist/browser-extension");
  expect(packageJson.files).toContain("dist/pi");
  expect(packageJson.files).not.toContain("dist");
  expect(packageJson.files.filter((path) => path === "src" || path.startsWith("src/"))).toEqual([]);
  expect(packageJson).not.toHaveProperty("dependencies");
  expect(packageJson.pi.extensions).toEqual(["./dist/pi/extension.js"]);
  expect(packageJson.scripts.prepack).toBe("vp run build");
  expect(packageJson.scripts.prepublishOnly).toBe("vp run release");
  expect(tasks.build?.command).toBe("node scripts/build.ts");
  expect(tasks["package:artifact"]?.command).toBe("node scripts/package-artifact.ts");
  expect(tasks.verify?.command).toContain("vp run package:artifact");
  expect(tasks.verify?.command).toContain("vp run build");
  expect(tasks.release?.command).toEqual(["vp run verify", "vp run smoke:connector:release"]);
  expect(tasks["smoke:connector:release"]?.command).toBe(
    "node scripts/smoke-connector.ts --require-browser",
  );
  expect(lintOptions).toEqual({ typeAware: true, typeCheck: false });
  expect(tasks.verify?.command).toContain("vp run typecheck");
});

it("requires a version-matched release tag", () => {
  expect(() => requireReleaseTag(`v${packageJson.version}`, packageJson.version)).not.toThrow();
  expect(() => requireReleaseTag(packageJson.version, packageJson.version)).toThrow(
    `Tag ${packageJson.version} does not match package version ${packageJson.version}.`,
  );
  expect(() => requireReleaseTag(undefined, packageJson.version)).toThrow(
    `Tag <missing> does not match package version ${packageJson.version}.`,
  );
});
