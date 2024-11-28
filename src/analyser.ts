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
import type { ScriptURL, ScriptToAPIKeySource } from "./types";

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

  static filterThreadsByPage(
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

  setThreadsPerProcess(
    threadsPerProcess: Map<GeckoSubprocessProfile, GeckoThread[]>
  ) {
    this.threadsPerProcess = threadsPerProcess;
  }

  setCategories(categories: CategoryList) {
    this.categories = categories;
  }

  static #isStackRoot(
    stack: GeckoStackTable["data"][0],
    schema: GeckoStackTable["schema"]
  ) {
    return stack[schema.prefix] === null;
  }

  #isParentAValidScriptStack(
    thread: GeckoThread,
    stack: GeckoStackTable["data"][0]
  ): boolean {
    // Root stack doesn't have any category or innerWindowID
    // So it is no use to check stacks that are roots or if their
    // parent is the root
    if (Analyser.#isStackRoot(stack, thread.stackTable.schema)) {
      // Stack is the root
      return false;
    }

    const parentStack =
      thread.stackTable.data[stack[thread.stackTable.schema.prefix]!];

    if (Analyser.#isStackRoot(parentStack, thread.stackTable.schema)) {
      // Parent is the root
      return false;
    }

    const parentFrame =
      thread.frameTable.data[parentStack[thread.stackTable.schema.frame]];
    const parentFrameCategory = parentFrame[thread.frameTable.schema.category];

    if (this.categories[parentFrameCategory!].name !== "JavaScript") {
      // Parent frame is not JavaScript
      // Traverse up the stack to find a valid script
      return this.#isParentAValidScriptStack(thread, parentStack);
    }

    const parentFrameString =
      thread.stringTable[parentFrame[thread.frameTable.schema.location]];
    if (parentFrameString.match(/pptr:internal|pptr:evaluateHandle/)) {
      // Ignore puppeteer internal scripts
      return false;
    }

    return true;
  }

  #shouldIgnoreSample(thread: GeckoThread, sample: GeckoSamples["data"][0]) {
    const stack = thread.stackTable.data[sample[thread.samples.schema.stack]!];
    const frame = thread.frameTable.data[stack[thread.stackTable.schema.frame]];
    const frameString =
      thread.stringTable[frame[thread.frameTable.schema.location]];

    // Ignore non-DOM frames
    if (!frameString.startsWith("(DOM) ")) {
      return true;
    }

    // Ignore frames that don't have a script
    return !this.#isParentAValidScriptStack(thread, stack);
  }

  #shouldIgnoreScriptURL(scriptURL: ScriptURL) {
    if (!scriptURL) {
      return false;
    }

    return (
      scriptURL.startsWith("chrome://") ||
      scriptURL.startsWith("moz-extension://")
    );
  }

  static scriptURLFromLabel(label: string) {
    // Script URLs are in the format of "something (https://url.com/path:line:col)"
    // or "something (https://url.com/ line 7327 > injectedScript line 2 > eval line 6206 > eval line 1 > eval line 1 > eval:1:165)"
    // This regex will return "https://url.com/path" for the first case and "https://url.com/" for the second case.
    return label.match(/\((.+?)(?: .+)?(?::\d+:\d+)\)/)?.[1] ?? null;
  }

  static embedderChain(pages: Record<number, Page>, page: Page) {
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

  #recordAPIUsage(scriptSoure: ScriptToAPIKeySource, api: string) {
    const scriptHash = JSON.stringify(scriptSoure);
    let scriptDoms = this.scriptToAPI.get(scriptHash);
    if (!scriptDoms) {
      scriptDoms = new Map();
      this.scriptToAPI.set(scriptHash, scriptDoms);
    }

    const count = scriptDoms.get(api) || 0;
    scriptDoms.set(api, count + 1);
  }

  #findStackWithValidURL(
    stack: GeckoStackTable["data"][0],
    thread: GeckoThread
  ): [GeckoStackTable["data"][0], string] | null {
    if (!stack) {
      return null;
    }

    const stackURL = this.#getURLFromStack(stack, thread);
    if (stackURL) {
      return [stack, stackURL];
    }

    const parentStack =
      thread.stackTable.data[stack[thread.stackTable.schema.prefix]!];

    return this.#findStackWithValidURL(parentStack, thread);
  }

  #getURLFromStack(
    stack: GeckoStackTable["data"][0],
    thread: GeckoThread
  ): string | null {
    if (Analyser.#isStackRoot(stack, thread.stackTable.schema)) {
      return null;
    }

    const frame = thread.frameTable.data[stack[thread.stackTable.schema.frame]];
    const frameCategory = frame[thread.frameTable.schema.category];

    if (this.categories[frameCategory!].name !== "JavaScript") {
      return null;
    }

    const parentFrameString =
      thread.stringTable[frame[thread.frameTable.schema.location]];

    const url = Analyser.scriptURLFromLabel(parentFrameString);
    if (!url) {
      return null;
    }

    try {
      new URL(url);
      return url;
    } catch {
      return null;
    }
  }

  #analyseThread(process: GeckoSubprocessProfile, thread: GeckoThread) {
    const pagesByInnerWindowId = (process.pages ?? []).reduce((acc, page) => {
      acc[page.innerWindowID] = page;
      return acc;
    }, {} as Record<number, Page>);

    for (const sample of thread.samples.data) {
      if (this.#shouldIgnoreSample(thread, sample)) {
        continue;
      }

      const stack =
        thread.stackTable.data[sample[thread.samples.schema.stack]!];
      const frame =
        thread.frameTable.data[stack[thread.stackTable.schema.frame]];
      const frameString =
        thread.stringTable[frame[thread.frameTable.schema.location]];
      const parentStack =
        thread.stackTable.data[stack[thread.stackTable.schema.prefix]!];

      const scriptURL = this.#getURLFromStack(stack, thread);
      const stackWithValidURL = this.#findStackWithValidURL(stack, thread);
      const validScriptURL = stackWithValidURL ? stackWithValidURL[1] : null;

      if (
        this.#shouldIgnoreScriptURL(scriptURL) ||
        this.#shouldIgnoreScriptURL(validScriptURL)
      ) {
        continue;
      }

      const pageLookupStack = stackWithValidURL
        ? stackWithValidURL[0]
        : parentStack;
      const pageLookupFrame =
        thread.frameTable.data[pageLookupStack[thread.stackTable.schema.frame]];
      const page =
        pagesByInnerWindowId[
          pageLookupFrame[thread.frameTable.schema.innerWindowID]!
        ];
      const embedderChain = Analyser.embedderChain(pagesByInnerWindowId, page);
      const firstParty = embedderChain.pop() ?? null;
      const thirdParty = embedderChain[0] ?? null;

      this.#recordAPIUsage(
        [firstParty, thirdParty, scriptURL, validScriptURL],
        frameString
      );
    }
  }

  analyse() {
    for (const [process, threads] of this.threadsPerProcess.entries()) {
      for (const thread of threads) {
        this.#analyseThread(process, thread);
      }
    }
  }
}

type ScriptToAPISourceHashKey = string;
type ScriptToAPICallCounter = Map<string, number>;
type ScriptToAPI = Map<ScriptToAPISourceHashKey, ScriptToAPICallCounter>;
