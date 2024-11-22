import type {
  CategoryList,
  GeckoProfile,
  GeckoSamples,
  GeckoStackTable,
  GeckoSubprocessProfile,
  GeckoThread,
  Page,
} from "./profilerTypes";
import { URL } from "node:url";
import type { ScriptURL, FirstPartyURL, ThirdPartyURL } from "./types";

export default class Analyser {
  threadsPerProcess: Map<GeckoSubprocessProfile, GeckoThread[]>;
  // This counts the number of calls to each DOM category samples
  // per script. The key is the script name and the value is a map
  // of api called to the number of times it was called.
  scriptToAPI: ScriptToAPI;
  categories: CategoryList;

  constructor() {
    this.threadsPerProcess = new Map();
    this.scriptToAPI = new Map();
    this.categories = [];
  }

  static async filterThreadsByPage(
    profile: GeckoProfile,
    filter: (page: Page) => boolean
  ) {
    const threadsPerProcess: Map<GeckoSubprocessProfile, GeckoThread[]> =
      new Map();
    for (const process of profile.processes) {
      if (!process.pages) {
        continue;
      }

      const threads: GeckoThread[] = [];
      for (const page of process.pages) {
        if (filter(page)) {
          threads.push(...process.threads);
          break;
        }
      }

      if (threads.length > 0) {
        threadsPerProcess.set(process, threads);
      }
    }
    return threadsPerProcess;
  }

  async setThreadsPerProcess(
    threadsPerProcess: Map<GeckoSubprocessProfile, GeckoThread[]>
  ) {
    this.threadsPerProcess = threadsPerProcess;
  }

  async setCategories(categories: CategoryList) {
    this.categories = categories;
  }

  static async #isStackRoot(
    stack: GeckoStackTable["data"][0],
    schema: GeckoStackTable["schema"]
  ) {
    return stack[schema.prefix] === null;
  }

  async #isParentAValidScriptStack(
    thread: GeckoThread,
    stack: GeckoStackTable["data"][0]
  ) {
    // Root stack doesn't have any category or innerWindowID
    // So it is no use to check stacks that are roots or if their
    // parent is the root
    if (await Analyser.#isStackRoot(stack, thread.stackTable.schema)) {
      // Stack is the root
      return false;
    }

    const parentStack =
      thread.stackTable.data[stack[thread.stackTable.schema.prefix]!];

    if (await Analyser.#isStackRoot(parentStack, thread.stackTable.schema)) {
      // Parent is the root
      return false;
    }

    const parentFrame =
      thread.frameTable.data[parentStack[thread.stackTable.schema.frame]!];
    const parentFrameCategory = parentFrame[thread.frameTable.schema.category];

    if (this.categories[parentFrameCategory!].name !== "JavaScript") {
      return false;
    }

    const parentFrameString =
      thread.stringTable[parentFrame[thread.frameTable.schema.location]];
    if (parentFrameString.match(/pptr:internal|pptr:evaluateHandle/)) {
      // Ignore puppeteer internal scripts
      return false;
    }

    return true;
  }

  async #shouldIgnoreSample(
    thread: GeckoThread,
    sample: GeckoSamples["data"][0]
  ) {
    const stack = thread.stackTable.data[sample[thread.samples.schema.stack]!];
    const frame =
      thread.frameTable.data[stack[thread.stackTable.schema.frame]!];
    const frameString =
      thread.stringTable[frame[thread.frameTable.schema.location]];

    // Ignore non-DOM frames
    if (!frameString.startsWith("(DOM) ")) {
      return true;
    }

    // Ignore frames that don't have a script
    return !(await this.#isParentAValidScriptStack(thread, stack));
  }

  async #shouldIgnoreScriptURL(scriptURL: ScriptURL) {
    if (!scriptURL) {
      return false;
    }

    return (
      scriptURL.startsWith("chrome://") ||
      scriptURL.startsWith("moz-extension://")
    );
  }

  static async scriptURLFromLabel(label: string) {
    // Script URLs are in the format of "something (https://url.com/path:line:col)"
    // or "something (https://url.com/ line 7327 > injectedScript line 2 > eval line 6206 > eval line 1 > eval line 1 > eval:1:165)"
    // This regex will return "https://url.com/path" for the first case and "https://url.com/" for the second case.
    return label.match(/\((.+?)(?: .+)?(?::\d+:\d+)\)/)?.[1] ?? null;
  }

  static async embedderChain(pages: Record<number, Page>, page: Page) {
    if (!page) {
      return [];
    }

    const chain = [page.url];
    let currentInnerWindowId = page.innerWindowID;
    while (pages[currentInnerWindowId].embedderInnerWindowID) {
      currentInnerWindowId = pages[currentInnerWindowId].embedderInnerWindowID;
      chain.push(pages[currentInnerWindowId].url);
    }

    return chain;
  }

  async #recordAPIUsage(scriptSoure: ScriptToAPIKeySource, api: string) {
    const scriptHash = JSON.stringify(scriptSoure);
    let scriptDoms = this.scriptToAPI.get(scriptHash);
    if (!scriptDoms) {
      scriptDoms = new Map();
      this.scriptToAPI.set(scriptHash, scriptDoms);
    }

    const count = scriptDoms.get(api) || 0;
    scriptDoms.set(api, count + 1);
  }

  async #findScriptURL(
    stack: GeckoStackTable["data"][0],
    thread: GeckoThread,
    traverseUntilValidURL: boolean
  ): Promise<string | null> {
    if (await Analyser.#isStackRoot(stack, thread.stackTable.schema)) {
      return null;
    }

    const parentStack =
      thread.stackTable.data[stack[thread.stackTable.schema.prefix]!];

    if (await Analyser.#isStackRoot(parentStack, thread.stackTable.schema)) {
      return null;
    }

    const parentFrame =
      thread.frameTable.data[parentStack[thread.stackTable.schema.frame]!];
    const parentFrameCategory = parentFrame[thread.frameTable.schema.category];

    if (this.categories[parentFrameCategory!].name !== "JavaScript") {
      return this.#findScriptURL(parentStack, thread, traverseUntilValidURL);
    }

    const parentFrameString =
      thread.stringTable[parentFrame[thread.frameTable.schema.location]];

    const url = await Analyser.scriptURLFromLabel(parentFrameString);
    if (!traverseUntilValidURL) {
      return url;
    }

    try {
      new URL(url!);
      return url;
    } catch {
      return this.#findScriptURL(parentStack, thread, traverseUntilValidURL);
    }
  }

  async #analyseThread(process: GeckoSubprocessProfile, thread: GeckoThread) {
    const pagesByInnerWindowId = (process.pages ?? []).reduce((acc, page) => {
      acc[page.innerWindowID] = page;
      return acc;
    }, {} as Record<number, Page>);

    for (const sample of thread.samples.data) {
      if (await this.#shouldIgnoreSample(thread, sample)) {
        continue;
      }

      const stack =
        thread.stackTable.data[sample[thread.samples.schema.stack]!];
      const frame =
        thread.frameTable.data[stack[thread.stackTable.schema.frame]!];
      const frameString =
        thread.stringTable[frame[thread.frameTable.schema.location]];
      const parentStack =
        thread.stackTable.data[stack[thread.stackTable.schema.prefix]!];
      const parentFrame =
        thread.frameTable.data[parentStack[thread.stackTable.schema.frame]!];

      const scriptURL = await this.#findScriptURL(stack, thread, false);
      const validScriptURL = await this.#findScriptURL(stack, thread, true);

      if (
        (await this.#shouldIgnoreScriptURL(scriptURL)) ||
        (await this.#shouldIgnoreScriptURL(validScriptURL))
      ) {
        continue;
      }

      const page =
        pagesByInnerWindowId[parentFrame[thread.frameTable.schema.innerWindowID]!];
      const embedderChain = await Analyser.embedderChain(
        pagesByInnerWindowId,
        page
      );
      const firstParty = embedderChain.pop() ?? null;
      const thirdParty = embedderChain[0] ?? null;

      await this.#recordAPIUsage(
        [firstParty, thirdParty, scriptURL, validScriptURL],
        frameString
      );
    }
  }

  async analyse() {
    for (const [process, threads] of this.threadsPerProcess.entries()) {
      for (const thread of threads) {
        await this.#analyseThread(process, thread);
      }
    }
  }

  async toJSON() {
    function replacer(_: string, value: unknown) {
      if (value instanceof Map) {
        return Object.fromEntries(value);
      } else {
        return value;
      }
    }
    return JSON.stringify(this.scriptToAPI, replacer);
  }
}

type ScriptToAPIKeySource = [
  FirstPartyURL,
  ThirdPartyURL,
  ScriptURL,
  ScriptURL
];
type ScriptToAPISourceHashKey = string;
type ScriptToAPICallCounter = Map<string, number>;
type ScriptToAPI = Map<ScriptToAPISourceHashKey, ScriptToAPICallCounter>;
