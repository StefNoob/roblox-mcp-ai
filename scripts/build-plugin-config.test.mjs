import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("build:plugin recompiles studio-plugin sources before packaging the rbxmx", () => {
	assert.match(
		pkg.scripts["build:plugin"],
		/npm\s+--prefix\s+studio-plugin\s+run\s+build/,
	);
});
