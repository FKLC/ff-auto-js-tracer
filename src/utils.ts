import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

export async function waitUntilFileClosed(path: string) {
  while (true) {
    // lsof exits with status 1 if no processes are found
    try {
      execSync(`lsof -t ${path}`);
    } catch {
      break;
    }
    console.log(`Waiting for ${path} to be closed`);
    await setTimeout(1000);
  }
}

export async function waitUntilNewFileInFolder(
  dir: string,
  oldFiles: Set<string>
) {
  while (true) {
    const newFiles = (await getItemsInFolder(dir)).difference(oldFiles);
    if (newFiles.size === 1) {
      return Array.from(newFiles)[0];
    }
    console.log(`Waiting for a new file to be created in ${dir}.`);
    await setTimeout(100);
  }
}

export async function getItemsInFolder(dir: string) {
  return new Set(await fs.readdir(dir));
}

export function waitUntilSignal(signal: NodeJS.Signals) {
  return new Promise<void>((resolve) => {
    process.once(signal, () => {
      resolve();
    });
  });
}