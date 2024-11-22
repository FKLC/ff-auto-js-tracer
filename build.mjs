import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  packages: "external", // no need to bundle node_modules
  platform: "node",
  outfile: "dist/index.js",
});
