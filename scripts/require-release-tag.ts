import packageJson from "../package.json" with { type: "json" };
import { requireReleaseTag } from "./release-tag.ts";

requireReleaseTag(process.env.GITHUB_REF_NAME, packageJson.version);
