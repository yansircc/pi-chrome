import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { init, parse } from "es-module-lexer";

await init;

export const RELEASE_BUILD_GRAPH = {
  outputDirectory: "dist",
  browser: {
    directory: "browser-extension",
  },
  pi: {
    directory: "pi",
    source: "src/pi/extension.ts",
    output: "extension.js",
    packageEntry: "./dist/pi/extension.js",
    target: "node22",
    hostModules: ["@earendil-works/pi-coding-agent"],
  },
} as const;

const nodeModules = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`]),
);
const piHostModules = new Set<string>(RELEASE_BUILD_GRAPH.pi.hostModules);

export const isPiBundleExternal = (specifier: string): boolean =>
  nodeModules.has(specifier) || piHostModules.has(specifier);

const assertRelativeOutput = (output: string): void => {
  if (
    !output ||
    output === "." ||
    output === ".." ||
    output.startsWith("../") ||
    output.includes("\\") ||
    posix.isAbsolute(output) ||
    posix.normalize(output) !== output
  ) {
    throw new Error(`Release output must be a relative path: ${output}`);
  }
};

export const validateReleaseBuildGraph = (): void => {
  assertRelativeOutput(RELEASE_BUILD_GRAPH.outputDirectory);
  assertRelativeOutput(RELEASE_BUILD_GRAPH.browser.directory);
  assertRelativeOutput(RELEASE_BUILD_GRAPH.pi.directory);
  assertRelativeOutput(RELEASE_BUILD_GRAPH.pi.source);
  assertRelativeOutput(RELEASE_BUILD_GRAPH.pi.output);
  const derivedEntry = `./${posix.join(
    RELEASE_BUILD_GRAPH.outputDirectory,
    RELEASE_BUILD_GRAPH.pi.directory,
    RELEASE_BUILD_GRAPH.pi.output,
  )}`;
  if (RELEASE_BUILD_GRAPH.pi.packageEntry !== derivedEntry) {
    throw new Error("Pi package entry diverges from the release build graph");
  }
};

const moduleSpecifiers = (source: string, fileName: string): ReadonlyArray<string> => {
  const [imports] = parse(source, fileName);
  return imports.flatMap(({ n: specifier }) => (specifier === undefined ? [] : [specifier]));
};

export const validatePiBundleSource = (source: string, fileName: string): void => {
  if (/\brequire\s*\(/.test(source)) {
    throw new Error(`${fileName} contains a CommonJS runtime dependency`);
  }
  const unexpected = [...new Set(moduleSpecifiers(source, fileName))]
    .filter((specifier) => !isPiBundleExternal(specifier))
    .sort();
  if (unexpected.length > 0) {
    throw new Error(`${fileName} contains unbundled runtime imports: ${unexpected.join(", ")}`);
  }
};

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

export const validatePiBundleDirectory = async (directory: string): Promise<void> => {
  validateReleaseBuildGraph();
  const files = await listFiles(directory);
  if (files.length !== 1 || files[0] !== RELEASE_BUILD_GRAPH.pi.output) {
    throw new Error(`Pi bundle output mismatch: ${files.join(", ")}`);
  }
  const output = join(directory, RELEASE_BUILD_GRAPH.pi.output);
  validatePiBundleSource(await readFile(output, "utf8"), output);
};
