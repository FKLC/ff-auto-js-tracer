import assert from "assert";
import fs from "fs/promises";
import sqlite, { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import Analyser from "./analyser.js";
import Profiler from "./profiler.js";
import { GeckoProfile } from "./profilerTypes.js";
import type { ProfileJob } from "./types";

export default class Pipeline {
  jobChunks: ProfileJob[][];
  analyser?: Analyser;
  profiler?: Profiler;
  profilerConfig: Parameters<typeof Profiler.Create>[0];
  db: sqlite.DatabaseSync;
  static CHUNK_SIZE = 10;
  static TABLE_NAME = "analysis";

  constructor(
    jobs: ProfileJob[],
    dbPath: string,
    profilerConfig: Parameters<typeof Profiler.Create>[0]
  ) {
    this.jobChunks = [];
    for (let i = 0; i < jobs.length; i += Pipeline.CHUNK_SIZE) {
      this.jobChunks.push(jobs.slice(i, i + Pipeline.CHUNK_SIZE));
    }
    this.profilerConfig = profilerConfig;
    this.db = new DatabaseSync(dbPath);

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
    jobs: ProfileJob[],
    dbPath: string,
    profilerConfig: Parameters<typeof Profiler.Create>[0]
  ) {
    // Create the report directory if it doesn't exist
    await fs.mkdir(profilerConfig.reportDir, { recursive: true });

    return new Pipeline(jobs, dbPath, profilerConfig);
  }

  async close() {
    this.db.close();
  }

  async #getURLProperty(
    url: string,
    property:
      | Exclude<keyof URL, "toString" | "toJSON" | "searchParams">
      | "queryStripped"
  ): Promise<string> {
    // If the URL is not a valid URL, return it as is
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
        JSON.parse(scriptSource);
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
      this.profiler = await Profiler.Create(this.profilerConfig);
      this.profiler.jobs = jobs;

      const profilePaths = await this.profiler.processJobs();

      // Close the profiler to save resources
      await this.profiler.close();

      // Analyse the profiles
      this.analyser = new Analyser();
      for (const profilePath of profilePaths) {
        const profile = JSON.parse(
          await fs.readFile(profilePath, "utf8")
        ) as GeckoProfile;
        const threadsPerProcess = await Analyser.filterThreadsByPage(
          profile,
          (page) => page.url.startsWith("http")
        );
        await this.analyser.setCategories(profile.meta.categories);
        await this.analyser.setThreadsPerProcess(threadsPerProcess);

        await this.analyser.analyse();
      }

      // Write the analysis to Sqlite database
      await this.#writeResults();
    }
  }
}
