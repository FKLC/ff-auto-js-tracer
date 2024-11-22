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
