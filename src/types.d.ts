import type Profiler from "./profiler";

type Condition =
  | {
      waitFor: number;
    }
  | {
      waitForSelector: string;
    }
  | {
      waitForFunction: (instance: Profiler) => boolean;
    };
type ProfileJob = {
  name: string;
  url: string;
  startProfiler: "beforeload" | "afterload";
} & Condition;

type ScriptURL = string | null;
type FirstPartyURL = string | null;
type ThirdPartyURL = string | null;
type ScriptToAPIKeySource = [
  FirstPartyURL,
  ThirdPartyURL,
  ScriptURL,
  ScriptURL
];

type PipelineConfig = {
  jobs: ProfileJob[];
  dbPath: string;
  clearReportDir: boolean;
};
