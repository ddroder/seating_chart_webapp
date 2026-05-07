import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ChartState, HistoryEntrySummary } from "../shared/types";
import { createEmptyChart, normalizeChartState } from "./state";

interface HistoryFile {
  id: string;
  timestamp: string;
  action: string;
  chart: ChartState;
  summary: HistoryEntrySummary;
}

const HISTORY_LIMIT = 500;
const HISTORY_KEEP_DAYS = 30;

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

export async function saveHistorySnapshot(
  historyDir: string,
  chart: ChartState,
  action: string,
  totalGuestCount: number,
): Promise<HistoryEntrySummary> {
  await mkdir(historyDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const id = `${timestamp.replace(/[:.]/g, "-")}-${slugifyAction(action)}`;
  const summary = summarizeHistoryEntry(id, timestamp, action, chart, totalGuestCount);
  const historyFile: HistoryFile = { id, timestamp, action, chart, summary };
  const filePath = join(historyDir, `${id}.json`);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;

  await writeFile(temporaryPath, `${JSON.stringify(historyFile, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
  await pruneHistory(historyDir);

  return summary;
}

export async function listHistoryEntries(historyDir: string): Promise<HistoryEntrySummary[]> {
  let fileNames: string[];
  try {
    fileNames = await readdir(historyDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const entries = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map(async (fileName): Promise<HistoryEntrySummary | null> => {
        try {
          const raw = await readFile(join(historyDir, fileName), "utf8");
          const parsed = JSON.parse(raw) as Partial<HistoryFile>;
          return parsed.summary ?? null;
        } catch {
          return null;
        }
      }),
  );

  return entries
    .filter((entry): entry is HistoryEntrySummary => entry !== null)
    .sort((first, second) => second.timestamp.localeCompare(first.timestamp));
}

export async function loadHistoryChart(historyDir: string, historyId: string, validGuestIds: Set<string>): Promise<ChartState> {
  const safeHistoryId = basename(historyId).replace(/\.json$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(safeHistoryId)) {
    throw new Error("Invalid history snapshot id");
  }

  const raw = await readFile(join(historyDir, `${safeHistoryId}.json`), "utf8");
  const parsed = JSON.parse(raw) as Partial<HistoryFile>;
  return normalizeChartState(parsed.chart, validGuestIds);
}

function summarizeHistoryEntry(
  id: string,
  timestamp: string,
  action: string,
  chart: ChartState,
  totalGuestCount: number,
): HistoryEntrySummary {
  const ignoredGuestIds = new Set(chart.ignoredGuestIds);
  const seatedGuestIds = new Set<string>();
  chart.tables.forEach((table) => {
    table.seats.forEach((seat) => {
      if (seat.guestId && !ignoredGuestIds.has(seat.guestId)) {
        seatedGuestIds.add(seat.guestId);
      }
    });
  });

  return {
    id,
    timestamp,
    action,
    tableCount: chart.tables.length,
    activeGuestCount: totalGuestCount - ignoredGuestIds.size,
    seatedGuestCount: seatedGuestIds.size,
    ignoredGuestCount: ignoredGuestIds.size,
  };
}

async function pruneHistory(historyDir: string): Promise<void> {
  const fileNames = (await readdir(historyDir)).filter((fileName) => fileName.endsWith(".json")).sort().reverse();
  const cutoff = Date.now() - HISTORY_KEEP_DAYS * 24 * 60 * 60 * 1000;

  await Promise.all(
    fileNames.map(async (fileName, index) => {
      const fileTime = parseHistoryFileTime(fileName);
      const keepByAge = Number.isFinite(fileTime) && fileTime >= cutoff;
      if (index < HISTORY_LIMIT || keepByAge) {
        return;
      }

      await unlink(join(historyDir, fileName));
    }),
  );
}

function parseHistoryFileTime(fileName: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(fileName);
  if (!match) {
    return Number.NaN;
  }

  const [, year, month, day, hour, minute, second, millisecond] = match;
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`);
}

function slugifyAction(action: string): string {
  return action.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "snapshot";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
