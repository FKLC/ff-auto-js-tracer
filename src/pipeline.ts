import assert from "node:assert";
import buffer from "node:buffer";
import fs from "node:fs/promises";
import sqlite, { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import Analyser from "./analyser.js";
import Profiler from "./profiler.js";
import { GeckoProfile } from "./profilerTypes.js";
import type { PipelineConfig, ProfileJob, ScriptToAPIKeySource } from "./types";

export default class Pipeline {
  jobChunks: ProfileJob[][];
  clearReportDir: boolean;
  analyser?: Analyser;
  profiler?: Profiler;
  profilerConfig: Parameters<typeof Profiler.Create>[0];
  db: sqlite.DatabaseSync;
  static CHUNK_SIZE = 10;
  static TABLE_NAME = "analysis";

  constructor(
    pipelineConfig: PipelineConfig,
    profilerConfig: Parameters<typeof Profiler.Create>[0]
  ) {
    this.jobChunks = [];
    for (let i = 0; i < pipelineConfig.jobs.length; i += Pipeline.CHUNK_SIZE) {
      this.jobChunks.push(
        pipelineConfig.jobs.slice(i, i + Pipeline.CHUNK_SIZE)
      );
    }
    this.profilerConfig = profilerConfig;
    this.db = new DatabaseSync(pipelineConfig.dbPath);
    this.clearReportDir = pipelineConfig.clearReportDir;

    this.#createTables();
  }

  #createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${Pipeline.TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        firstPartyOrigin TEXT,
        firstPartyURL TEXT,
        thirdPartyOrigin TEXT,
        thirdPartyURL TEXT,
        scriptOrigin TEXT,
        scriptURLWOQuery TEXT,
        scriptURL TEXT,
        validScriptOrigin TEXT,
        validScriptURLWOQuery TEXT,
        validScriptURL TEXT,
        apiCalled TEXT NOT NULL,
        numCalls INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_source
      ON ${Pipeline.TABLE_NAME} (
        firstPartyOrigin,
        firstPartyURL,
        thirdPartyOrigin,
        thirdPartyURL,
        scriptOrigin,
        scriptURLWOQuery,
        scriptURL,
        validScriptOrigin,
        validScriptURLWOQuery,
        validScriptURL,
        apiCalled
      );
    `);
  }

  static async Create(
    pipelineConfig: PipelineConfig,
    profilerConfig: Parameters<typeof Profiler.Create>[0]
  ) {
    // Create the report directory if it doesn't exist
    await fs.mkdir(profilerConfig.reportDir, { recursive: true });

    return new Pipeline(pipelineConfig, profilerConfig);
  }

  close() {
    this.db.close();
  }

  #getURLProperty(
    url: string | null,
    property:
      | Exclude<keyof URL, "toString" | "toJSON" | "searchParams">
      | "queryStripped"
  ): string | null {
    // If the URL is not a valid URL, return it as is

    if (!url) {
      return url;
    }

    try {
      new URL(url);
    } catch {
      return url;
    }

    const urlObj = new URL(url);
    if (property === "queryStripped") {
      return urlObj.origin + urlObj.pathname;
    }

    return urlObj[property];
  }

  async #writeResults() {
    assert(this.analyser);
    const insert = this.db.prepare(`
      INSERT INTO ${Pipeline.TABLE_NAME} (
        firstPartyOrigin,
        firstPartyURL,
        thirdPartyOrigin,
        thirdPartyURL,
        scriptOrigin,
        scriptURLWOQuery,
        scriptURL,
        validScriptOrigin,
        validScriptURLWOQuery,
        validScriptURL,
        apiCalled,
        numCalls
      ) VALUES(
       IFNULL(?, ''),
       IFNULL(?, ''),
       IFNULL(?, ''),
       IFNULL(?, ''),
       IFNULL(?, ''),
       IFNULL(?, ''),
       IFNULL(?, ''),
       IFNULL(?, ''),
       IFNULL(?, ''),
       IFNULL(?, ''),
       ?,
       ?
      )
      ON CONFLICT (
        firstPartyOrigin,
        firstPartyURL,
        thirdPartyOrigin,
        thirdPartyURL,
        scriptOrigin,
        scriptURLWOQuery,
        scriptURL,
        validScriptOrigin,
        validScriptURLWOQuery,
        validScriptURL,
        apiCalled
      ) DO UPDATE SET numCalls = numCalls + ?;
    `);

    for (const [scriptSource, counter] of this.analyser.scriptToAPI.entries()) {
      const [firstPartyURL, thirdPartyURL, scriptURL, validScriptURL] =
        JSON.parse(scriptSource) as ScriptToAPIKeySource;
      const [
        firstPartyOrigin,
        thirdPartyOrigin,
        scriptOrigin,
        scriptURLWOQuery,
        validScriptOrigin,
        validScriptURLWOQuery,
      ] = await Promise.all([
        this.#getURLProperty(firstPartyURL, "origin"),
        this.#getURLProperty(thirdPartyURL, "origin"),
        this.#getURLProperty(scriptURL, "origin"),
        this.#getURLProperty(scriptURL, "queryStripped"),
        this.#getURLProperty(validScriptURL, "origin"),
        this.#getURLProperty(validScriptURL, "queryStripped"),
      ]);

      for (const [api, numCalls] of counter.entries()) {
        insert.run(
          firstPartyOrigin,
          firstPartyURL,
          thirdPartyOrigin,
          thirdPartyURL,
          scriptOrigin,
          scriptURLWOQuery,
          scriptURL,
          validScriptOrigin,
          validScriptURLWOQuery,
          validScriptURL,
          api,
          numCalls,
          numCalls
        );
      }
    }
  }

  async run() {
    for (const jobs of this.jobChunks) {
      // Create a new profiler (a new browser instance) for each chunk of jobs.
      // We will close the profiler after processing the jobs to save resources.
      //this.profiler = await Profiler.Create(this.profilerConfig);
      //this.profiler.jobs = jobs;

      const profilePaths = await fs
        .readdir(this.profilerConfig.reportDir)
        .then((r) =>
          r
            .filter((i) => i.endsWith(".json"))
            .map((r) => this.profilerConfig.reportDir + "/" + r)
        ); // await this.profiler.processJobs();

      // Close the profiler to save resources
      //await this.profiler.close();

      // Analyse the profiles
      this.analyser = new Analyser();
      for (const profilePath of profilePaths) {
        const stat = await fs.stat(profilePath);
        if (stat.size > buffer.constants.MAX_STRING_LENGTH) {
          console.error(
            `File ${profilePath} is too large to be read by the pipeline.`
          );
          continue;
        }
        const contents = await fs.readFile(profilePath, "utf8").catch((e) => {
          console.error(`Error reading file ${profilePath}: ${e}`);
          return null;
        });
        if (!contents) {
          continue;
        }
        const profile = JSON.parse(contents) as GeckoProfile;
        const threadsPerProcess = Analyser.filterThreadsByPage(
          profile,
          (page) => page.url.startsWith("http")
        );
        this.analyser.setCategories(profile.meta.categories);
        this.analyser.setThreadsPerProcess(threadsPerProcess);

        this.analyser.analyse();
      }

      // Write the analysis to Sqlite database
      await this.#writeResults();

      // Clear the report directory if required
      if (this.clearReportDir) {
        for (const profilePath of profilePaths) {
          await fs.rm(profilePath);
        }
      }
    }
  }
}
