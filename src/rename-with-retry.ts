import { rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

export async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (attempt === 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await setTimeout(10 * 2 ** attempt);
    }
  }
}
