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
  ServerToClientEvents,
} from "../shared/types";
import { clearSeat, createTable, deleteTable, assignSeat, updateTable } from "./state";
import { loadChartState, saveChartState } from "./store";
import { loadGuestData } from "./workbook";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const workbookPath = resolve(projectRoot, process.env.GUEST_WORKBOOK ?? "export.xlsx");
const statePath = resolve(projectRoot, process.env.STATE_FILE ?? "data/seating-chart.json");
const distPath = resolve(projectRoot, "dist");
const distIndexPath = resolve(distPath, "index.html");

const { guests, parties } = await loadGuestData(workbookPath);
const validGuestIds = new Set(guests.map((guest) => guest.id));
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
    void mutate(ack, (current) => createTable(current, input));
  });

  socket.on("table:update", (input, ack) => {
    void mutate(ack, (current) => updateTable(current, input));
  });

  socket.on("table:delete", (input, ack) => {
    void mutate(ack, (current) => deleteTable(current, input));
  });

  socket.on("seat:assign", (input, ack) => {
    void mutate(ack, (current) => assignSeat(current, input, validGuestIds));
  });

  socket.on("seat:clear", (input, ack) => {
    void mutate(ack, (current) => clearSeat(current, input));
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

async function mutate(ack: (result: MutationAck) => void, mutation: (current: ChartState) => ChartState): Promise<void> {
  const result = mutationQueue.then(async (): Promise<MutationAck> => {
    try {
      const nextChart = mutation(chart);
      if (nextChart !== chart) {
        await saveChartState(statePath, nextChart);
        chart = nextChart;
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
