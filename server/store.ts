import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ChartState } from "../shared/types";
import { createEmptyChart, normalizeChartState } from "./state";

export async function loadChartState(filePath: string, validGuestIds: Set<string>): Promise<ChartState> {
  try {
    const raw = await readFile(filePath, "utf8");
    return normalizeChartState(JSON.parse(raw), validGuestIds);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return createEmptyChart();
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Saved seating chart is not valid JSON: ${filePath}`);
    }

    throw error;
  }
}

export async function saveChartState(filePath: string, chart: ChartState): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(chart, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
