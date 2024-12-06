import path from "path";
import userConfig from "./user.config.js";

export default {
  firefoxPath: userConfig.firefoxPath,
  reportDir: path.resolve(userConfig.reportDir),
  clearReportDir: userConfig.clearReportDir,
  launchOptions: userConfig.launchOptions,
  jobs: userConfig.jobs,
  dbPath: path.resolve(userConfig.dbPath),
};
