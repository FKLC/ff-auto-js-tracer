import config from "../config.js";
import Pipeline from "./pipeline.js";
import type { ProfileJob } from "./types.js";

async function main() {
  const pipeline = await Pipeline.Create(
    config.jobs as ProfileJob[],
    config.dbPath,
    {
      firefoxPath: config.firefoxPath,
      reportDir: config.reportDir,
      launchOptions: config.launchOptions,
    }
  );
  await pipeline.run();
  pipeline.close();
}

void main();
