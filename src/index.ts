import config from "../config.js";
import Pipeline from "./pipeline.js";
import type { ProfileJob } from "./types.js";

async function main() {
  const pipeline = await Pipeline.Create(
    {
      jobs: config.jobs as ProfileJob[],
      dbPath: config.dbPath,
      clearReportDir: config.clearReportDir,
    },
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
