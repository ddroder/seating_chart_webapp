import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { Server } from "socket.io";

import type {
  AppSnapshot,
  ChartState,
  ClientToServerEvents,
  MutationAck,
  RestoreHistoryInput,
  ServerToClientEvents,
} from "../shared/types";
import {
  bulkUpdateGuests,
  clearSeat,
  createFloorPlanObject,
  createTable,
  deleteFloorPlanObject,
  deleteTable,
  assignSeat,
  seatPartyAtTable,
  setChartLocked,
  setGuestIgnored,
  setTableLocked,
  updateFloorPlanObject,
  updateGuestMetadata,
  updateTable,
} from "./state";
import { listHistoryEntries, loadChartState, loadHistoryChart, saveChartState, saveHistorySnapshot } from "./store";
import { loadGuestData } from "./workbook";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const workbookPath = resolve(projectRoot, process.env.GUEST_WORKBOOK ?? "export.xlsx");
const statePath = resolve(projectRoot, process.env.STATE_FILE ?? "data/seating-chart.json");
const historyPath = resolve(projectRoot, process.env.HISTORY_DIR ?? "data/history");
const distPath = resolve(projectRoot, "dist");
const distIndexPath = resolve(distPath, "index.html");

const { guests, parties } = await loadGuestData(workbookPath);
const validGuestIds = new Set(guests.map((guest) => guest.id));
const partiesById = new Map(parties.map((party) => [party.id, party]));
let chart = await loadChartState(statePath, validGuestIds);
let mutationQueue = Promise.resolve();

const app = express();
const server = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server);

app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, guests: guests.length, tables: chart.tables.length });
});

app.get("/api/bootstrap", (_request, response) => {
  response.json(snapshot());
});

app.get("/api/history", async (_request, response, next) => {
  try {
    response.json(await listHistoryEntries(historyPath));
  } catch (error) {
    next(error);
  }
});

app.use(express.static(distPath));

app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/api")) {
    next();
    return;
  }

  if (!existsSync(distIndexPath)) {
    response.status(404).send("Frontend build not found. Run `npm run build` before `npm start`.");
    return;
  }

  response.sendFile(distIndexPath);
});

io.on("connection", (socket) => {
  broadcastSnapshot();

  socket.on("table:create", (input, ack) => {
    void mutate("table:create", ack, (current) => createTable(current, input));
  });

  socket.on("table:update", (input, ack) => {
    void mutate("table:update", ack, (current) => updateTable(current, input));
  });

  socket.on("table:delete", (input, ack) => {
    void mutate("table:delete", ack, (current) => deleteTable(current, input));
  });

  socket.on("seat:assign", (input, ack) => {
    void mutate("seat:assign", ack, (current) => assignSeat(current, input, validGuestIds));
  });

  socket.on("seat:clear", (input, ack) => {
    void mutate("seat:clear", ack, (current) => clearSeat(current, input));
  });

  socket.on("guest:ignore", (input, ack) => {
    void mutate("guest:ignore", ack, (current) => setGuestIgnored(current, input, validGuestIds));
  });

  socket.on("guest:metadata:update", (input, ack) => {
    void mutate("guest:metadata:update", ack, (current) => updateGuestMetadata(current, input, validGuestIds));
  });

  socket.on("guests:bulkUpdate", (input, ack) => {
    void mutate("guests:bulkUpdate", ack, (current) => bulkUpdateGuests(current, input, validGuestIds));
  });

  socket.on("party:seatAtTable", (input, ack) => {
    void mutate("party:seatAtTable", ack, (current) => {
      const party = partiesById.get(input.partyId);
      if (!party) {
        throw new Error("Party not found");
      }

      return seatPartyAtTable(current, input, party.guestIds);
    });
  });

  socket.on("history:restore", (input, ack) => {
    void restoreHistory(input, ack);
  });

  socket.on("chart:lock", (input, ack) => {
    void mutate("chart:lock", ack, (current) => setChartLocked(current, input));
  });

  socket.on("table:lock", (input, ack) => {
    void mutate("table:lock", ack, (current) => setTableLocked(current, input));
  });

  socket.on("floor:create", (input, ack) => {
    void mutate("floor:create", ack, (current) => createFloorPlanObject(current, input));
  });

  socket.on("floor:update", (input, ack) => {
    void mutate("floor:update", ack, (current) => updateFloorPlanObject(current, input));
  });

  socket.on("floor:delete", (input, ack) => {
    void mutate("floor:delete", ack, (current) => deleteFloorPlanObject(current, input));
  });

  socket.on("disconnect", () => {
    broadcastSnapshot();
  });
});

server.listen(port, host, () => {
  console.log(`Seating chart server listening on http://${host}:${port}`);
  console.log(`Loaded ${guests.length} guests from ${workbookPath}`);
});

function snapshot(): AppSnapshot {
  return {
    guests,
    parties,
    chart,
    connectedUsers: io.of("/").sockets.size,
  };
}

function broadcastSnapshot(): void {
  io.emit("snapshot", snapshot());
}

async function mutate(
  action: string,
  ack: (result: MutationAck) => void,
  mutation: (current: ChartState) => ChartState,
): Promise<void> {
  const result = mutationQueue.then(async (): Promise<MutationAck> => {
    try {
      const nextChart = mutation(chart);
      if (nextChart !== chart) {
        await saveChartState(statePath, nextChart);
        chart = nextChart;
        await saveHistorySnapshot(historyPath, chart, action, guests.length);
      }

      broadcastSnapshot();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown seating chart error";
      return { ok: false, error: message };
    }
  });

  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );

  ack(await result);
}

async function restoreHistory(input: RestoreHistoryInput, ack: (result: MutationAck) => void): Promise<void> {
  const result = mutationQueue.then(async (): Promise<MutationAck> => {
    try {
      await saveHistorySnapshot(historyPath, chart, "history:restore-safety", guests.length);
      const restoredChart = await loadHistoryChart(historyPath, input.historyId, validGuestIds);
      await saveChartState(statePath, restoredChart);
      chart = restoredChart;
      await saveHistorySnapshot(historyPath, chart, "history:restore", guests.length);
      broadcastSnapshot();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to restore history snapshot";
      return { ok: false, error: message };
    }
  });

  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );

  ack(await result);
}
