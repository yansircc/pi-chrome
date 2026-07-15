import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { validateExtensionDirectory } from "./extension-build-graph.ts";
import {
  RELEASE_BUILD_GRAPH,
  validatePiBundleDirectory,
  validateReleaseBuildGraph,
} from "./release-build-graph.ts";

type PackageManifest = {
  readonly name: string;
  readonly version: string;
  readonly pi?: { readonly extensions?: ReadonlyArray<string> };
  readonly dependencies?: Readonly<Record<string, string>>;
};

type CommandOptions = {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
};

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions,
): Promise<string> =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun(stdout);
      else {
        rejectRun(
          new Error(
            `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `code ${String(code)}`}\n${stderr || stdout}`,
          ),
        );
      }
    });
  });

const listFiles = async (directory: string, prefix = ""): Promise<Array<string>> => {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files: Array<string> = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(directory, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
};

export const validatePackedFileSet = (
  packedFiles: ReadonlySet<string>,
  requiredRepositoryFiles: ReadonlySet<string>,
): void => {
  const missing = [...requiredRepositoryFiles]
    .map((path) => `package/${path}`)
    .filter((path) => !packedFiles.has(path))
    .sort();
  if (missing.length > 0)
    throw new Error(`Package tarball is missing runtime files: ${missing.join(", ")}`);
  const tests = [...packedFiles].filter(
    (path) => path === "package/test-suite" || path.startsWith("package/test-suite/"),
  );
  if (tests.length > 0)
    throw new Error(`Package tarball contains test-suite files: ${tests.join(", ")}`);
  const sourceFiles = [...packedFiles].filter((path) => path.startsWith("package/src/")).sort();
  if (sourceFiles.length > 0) {
    throw new Error(
      `Package tarball contains source files instead of release artifacts: ${sourceFiles.join(", ")}`,
    );
  }
  const expectedBuildArtifacts = new Set(
    [...requiredRepositoryFiles]
      .filter((path) => path.startsWith(`${RELEASE_BUILD_GRAPH.outputDirectory}/`))
      .map((path) => `package/${path}`),
  );
  const unexpectedBuildArtifacts = [...packedFiles]
    .filter((path) => path.startsWith("package/dist/") && !expectedBuildArtifacts.has(path))
    .sort();
  if (unexpectedBuildArtifacts.length > 0) {
    throw new Error(
      `Package tarball contains undeclared release artifacts: ${unexpectedBuildArtifacts.join(", ")}`,
    );
  }
};

type ExpectedPack = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
};

export const packageArchiveFilename = (name: string, version: string): string => {
  const identity = name.startsWith("@") ? name.slice(1).split("/") : [name];
  if (identity.some((part) => !part) || identity.length > 2) {
    throw new Error(`Invalid npm package identity: ${name}`);
  }
  return `${identity.join("-")}-${version}.tgz`;
};

export const parsePnpmPackReport = (
  output: string,
  expected: ExpectedPack,
): ReadonlySet<string> => {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (cause) {
    throw new Error("pnpm pack did not return valid JSON", { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pnpm pack report must be an object");
  }
  const report = value as Readonly<Record<string, unknown>>;
  if (
    report.name !== expected.name ||
    report.version !== expected.version ||
    typeof report.filename !== "string" ||
    resolve(report.filename) !== resolve(expected.filename) ||
    !Array.isArray(report.files)
  ) {
    throw new Error("pnpm pack report does not identify the requested package artifact");
  }
  const files = new Set<string>();
  for (const item of report.files) {
    if (typeof item !== "object" || item === null || Array.isArray(item) || !("path" in item)) {
      throw new Error("pnpm pack report contains an invalid file entry");
    }
    const path = item.path;
    if (
      typeof path !== "string" ||
      !path ||
      path.includes("\\") ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    ) {
      throw new Error("pnpm pack report contains an invalid file path");
    }
    const packedPath = `package/${path}`;
    if (files.has(packedPath)) throw new Error(`pnpm pack report repeats file ${path}`);
    files.add(packedPath);
  }
  return files;
};

const readManifest = async (path: string): Promise<PackageManifest> =>
  JSON.parse(await readFile(path, "utf8")) as PackageManifest;

const packageEntries = (manifest: PackageManifest): ReadonlyArray<string> => {
  const entries = manifest.pi?.extensions;
  if (!entries || entries.length === 0)
    throw new Error("package.json must declare at least one Pi extension entry");
  return entries;
};

const validatePackageManifest = (manifest: PackageManifest): ReadonlyArray<string> => {
  const entries = packageEntries(manifest);
  if (entries.length !== 1 || entries[0] !== RELEASE_BUILD_GRAPH.pi.packageEntry) {
    throw new Error("package.json Pi entry diverges from the release build graph");
  }
  const dependencies = Object.keys(manifest.dependencies ?? {});
  if (dependencies.length > 0) {
    throw new Error(
      `Self-contained package must not declare install-time dependencies: ${dependencies.join(", ")}`,
    );
  }
  return entries;
};

const loadExtractedPiEntries = async (
  extractedRoot: string,
  agentDirectory: string,
  manifest: PackageManifest,
): Promise<void> => {
  const entries = validatePackageManifest(manifest).map((entry) => resolve(extractedRoot, entry));
  const loaded = await discoverAndLoadExtensions(entries, extractedRoot, agentDirectory);
  if (loaded.errors.length > 0) {
    throw new Error(
      `Extracted Pi extension failed to load without installed dependencies: ${loaded.errors
        .map(({ path, error }) => `${path}: ${error}`)
        .join("; ")}`,
    );
  }
  if (loaded.extensions.length !== entries.length) {
    throw new Error("Extracted package did not load every declared Pi extension entry");
  }
};

export const verifyPackageArtifact = async (root: string, archiveInput?: string): Promise<void> => {
  validateReleaseBuildGraph();
  const manifest = await readManifest(join(root, "package.json"));
  const connectorAuth = JSON.parse(
    await readFile(join(root, "src", "protocol", "connector-auth.json"), "utf8"),
  ) as { readonly extensionPublicKey: string };
  const entries = validatePackageManifest(manifest);
  const runtimeFiles = new Set<string>([
    "package.json",
    ...entries.map((entry) => entry.replace(/^\.\//, "")),
  ]);
  const extensionDirectory = join(
    root,
    RELEASE_BUILD_GRAPH.outputDirectory,
    RELEASE_BUILD_GRAPH.browser.directory,
  );
  for (const path of await listFiles(extensionDirectory)) {
    runtimeFiles.add(`dist/browser-extension/${path}`);
  }
  if (!runtimeFiles.has("dist/browser-extension/manifest.json")) {
    throw new Error("Built extension manifest is missing before package verification");
  }
  await validateExtensionDirectory(extensionDirectory, {
    version: manifest.version,
    publicKey: connectorAuth.extensionPublicKey,
  });
  await validatePiBundleDirectory(
    join(root, RELEASE_BUILD_GRAPH.outputDirectory, RELEASE_BUILD_GRAPH.pi.directory),
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-chrome-package-artifact-"));
  const failures: Array<unknown> = [];
  try {
    const tarball =
      archiveInput === undefined
        ? join(temporaryDirectory, packageArchiveFilename(manifest.name, manifest.version))
        : resolve(root, archiveInput);
    let packedFiles: ReadonlySet<string> | undefined;
    if (archiveInput === undefined) {
      const packReport = await run(
        "pnpm",
        ["--config.ignore-scripts=true", "pack", "--json", "--out", tarball],
        {
          cwd: root,
          env: { ...process.env, npm_config_ignore_scripts: "true" },
        },
      );
      packedFiles = parsePnpmPackReport(packReport, {
        name: manifest.name,
        version: manifest.version,
        filename: tarball,
      });
    }
    const extracted = join(temporaryDirectory, "extracted");
    await mkdir(extracted, { recursive: true });
    await run("tar", ["-xzf", tarball, "-C", extracted], { cwd: root });
    const extractedRoot = join(extracted, "package");
    const extractedFiles = new Set(
      (await listFiles(extractedRoot)).map((path) => `package/${path}`),
    );
    validatePackedFileSet(packedFiles ?? extractedFiles, runtimeFiles);
    const extractedManifest = await readManifest(join(extractedRoot, "package.json"));
    await loadExtractedPiEntries(
      extractedRoot,
      join(temporaryDirectory, "agent"),
      extractedManifest,
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `Package verification failed and temporary cleanup also failed for ${temporaryDirectory}`,
    );
  }
  if (failures.length === 1) throw failures[0];
};

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const archiveFlag = process.argv[2];
  if (archiveFlag !== undefined && archiveFlag !== "--archive") {
    throw new Error("usage: package-artifact.ts [--archive <archive>]");
  }
  const archiveArguments = process.argv.slice(3);
  if (archiveArguments[0] === "--") archiveArguments.shift();
  if (archiveFlag === "--archive" && archiveArguments.length !== 1) {
    throw new Error("--archive requires exactly one archive path");
  }
  await verifyPackageArtifact(dirname(dirname(currentFile)), archiveArguments[0]);
  console.log("PASS package artifact: tarball contents and zero-install Pi loading");
}
