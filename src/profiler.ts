import path from "node:path";
import { setTimeout } from "node:timers/promises";
import puppeteer, { Browser, PuppeteerLaunchOptions } from "puppeteer-core";
import {
  getItemsInFolder,
  waitUntilNewFileInFolder,
  waitUntilSignal,
} from "./utils";
import type { ProfileJob } from "./types";

export default class Profiler {
  browser: Browser;
  reportDir: string;
  jobs: ProfileJob[];

  static async Create({
    firefoxPath,
    reportDir,
    launchOptions,
  }: {
    firefoxPath: string;
    reportDir: string;
    launchOptions: PuppeteerLaunchOptions;
  }) {
    const browser = await puppeteer.launch({
      browser: "firefox",
      executablePath: firefoxPath,
      headless: false,
      env: {
        MOZ_UPLOAD_DIR: reportDir,
      },
      defaultViewport: null,
      ...launchOptions,
    });
    return new Profiler({ browser, reportDir });
  }

  constructor({ browser, reportDir }: { browser: Browser; reportDir: string }) {
    this.browser = browser;
    this.reportDir = reportDir;
    this.jobs = [];
  }

  async close() {
    await this.browser.close();
  }

  #start() {
    const pid = this.browser.process()?.pid;
    if (!pid) {
      throw new Error("Failed to get browser pid");
    }
    process.kill(pid, "SIGUSR1");
    console.log("Profiler started");
  }

  async #stop() {
    const pid = this.browser.process()?.pid;
    if (!pid) {
      throw new Error("Failed to get browser pid");
    }

    const oldFiles = await getItemsInFolder(this.reportDir);

    const [newFile] = await Promise.all([
      waitUntilNewFileInFolder(this.reportDir, oldFiles),
      waitUntilSignal("SIGUSR2").then(() => console.log("Profiler stopped")),
      // process.kill is not a promise, yes, but placing it here allows us
      // to avoid assigning Promise.all to a variable, call proces.kill and
      // then await the Promise.all variable.
      process.kill(pid, "SIGUSR2"),
    ]);

    const profilePath = path.join(this.reportDir, newFile);
    console.log(`Profile saved to ${profilePath}`);

    return profilePath;
  }

  async processJob(job: ProfileJob) {
    const context = await this.browser.createBrowserContext();
    const page = await context.newPage();

    if (job.startProfiler === "beforeload") {
      this.#start();
    }

    await page.goto(job.url).catch(async (err) => {
      // When the document changes its location, the page.goto promise is
      // rejected with an error. This is expected and we can ignore it.
      console.error(`Failed to load ${job.url}: ${err}`);

      // We will wait for the network to be idle and then continue.
      await page.waitForNetworkIdle().catch((err) => {
        console.error(`Failed to wait for network idle: ${err}`);
      });
    });

    if (job.startProfiler === "afterload") {
      this.#start();
    }

    if ("waitFor" in job) {
      await setTimeout(job.waitFor);
    } else if ("waitForSelector" in job) {
      await page.waitForSelector(job.waitForSelector);
    } else if ("waitForFunction" in job) {
      await page.waitForFunction(() => job.waitForFunction(this));
    }

    const profilePath = await this.#stop();

    await context.close();

    return profilePath;
  }

  async processJobs() {
    if (!this.browser.connected) {
      throw new Error("Browser is not connected");
    }

    const profilePaths = [];
    for (const job of this.jobs) {
      const profilePath = await this.processJob(job);
      profilePaths.push(profilePath);
    }

    return profilePaths;
  }
}
