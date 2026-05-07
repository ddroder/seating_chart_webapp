import { randomUUID } from "node:crypto";

import type {
  AssignSeatInput,
  ChartState,
  ClearSeatInput,
  CreateTableInput,
  DeleteTableInput,
  SeatAssignment,
  SeatingTable,
  TableShape,
  UpdateTableInput,
} from "../shared/types";

const MIN_SEATS = 1;
const MAX_SEATS = 32;
const MAX_TABLE_NAME_LENGTH = 48;

export class StateMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateMutationError";
  }
}

export function createEmptyChart(): ChartState {
  return {
    version: 1,
    tables: [],
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeChartState(value: unknown, validGuestIds: Set<string>): ChartState {
  if (!isObject(value) || !Array.isArray(value.tables)) {
    return createEmptyChart();
  }

  const usedGuestIds = new Set<string>();
  const tables: SeatingTable[] = [];

  value.tables.forEach((rawTable, tableIndex) => {
    if (!isObject(rawTable)) {
      return;
    }

    const seatCount = clampSeatCount(rawTable.seatCount);
    const table: SeatingTable = {
      id: typeof rawTable.id === "string" && rawTable.id ? rawTable.id : `table-${tableIndex + 1}`,
      name: normalizeTableName(rawTable.name, `Table ${tableIndex + 1}`),
      shape: isTableShape(rawTable.shape) ? rawTable.shape : "round",
      seatCount,
      x: finiteNumber(rawTable.x, 80 + tableIndex * 24),
      y: finiteNumber(rawTable.y, 80 + tableIndex * 24),
      seats: createSeats(seatCount),
    };

    if (Array.isArray(rawTable.seats)) {
      rawTable.seats.forEach((rawSeat) => {
        if (!isObject(rawSeat)) {
          return;
        }

        const index = Number(rawSeat.index);
        const guestId = rawSeat.guestId;
        if (!Number.isInteger(index) || index < 0 || index >= seatCount || typeof guestId !== "string") {
          return;
        }

        if (!validGuestIds.has(guestId) || usedGuestIds.has(guestId)) {
          return;
        }

        table.seats[index] = { index, guestId };
        usedGuestIds.add(guestId);
      });
    }

    tables.push(table);
  });

  return {
    version: 1,
    tables,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

export function createTable(chart: ChartState, input: CreateTableInput): ChartState {
  const shape = parseShape(input.shape);
  const seatCount = parseSeatCount(input.seatCount);
  const nextTableNumber = chart.tables.length + 1;
  const columns = 3;
  const column = (nextTableNumber - 1) % columns;
  const row = Math.floor((nextTableNumber - 1) / columns);

  const table: SeatingTable = {
    id: `table-${randomUUID()}`,
    name: `Table ${nextTableNumber}`,
    shape,
    seatCount,
    x: 72 + column * 360,
    y: 72 + row * 340,
    seats: createSeats(seatCount),
  };

  return touch({ ...chart, tables: [...chart.tables, table] });
}

export function updateTable(chart: ChartState, input: UpdateTableInput): ChartState {
  const tableIndex = chart.tables.findIndex((table) => table.id === input.tableId);
  if (tableIndex === -1) {
    throw new StateMutationError("Table not found");
  }

  const tables = chart.tables.map(copyTable);
  const table = tables[tableIndex];
  if (!table) {
    throw new StateMutationError("Table not found");
  }

  if (input.name !== undefined) {
    table.name = normalizeTableName(input.name, table.name);
  }

  if (input.shape !== undefined) {
    table.shape = parseShape(input.shape);
  }

  if (input.x !== undefined) {
    table.x = parseCoordinate(input.x);
  }

  if (input.y !== undefined) {
    table.y = parseCoordinate(input.y);
  }

  if (input.seatCount !== undefined) {
    const seatCount = parseSeatCount(input.seatCount);
    const removedOccupiedSeat = table.seats.some((seat) => seat.index >= seatCount && seat.guestId !== null);
    if (removedOccupiedSeat) {
      throw new StateMutationError("Cannot reduce seats because one of the removed seats is occupied");
    }

    table.seatCount = seatCount;
    table.seats = resizeSeats(table.seats, seatCount);
  }

  return touch({ ...chart, tables });
}

export function deleteTable(chart: ChartState, input: DeleteTableInput): ChartState {
  const table = chart.tables.find((candidate) => candidate.id === input.tableId);
  if (!table) {
    throw new StateMutationError("Table not found");
  }

  if (table.seats.some((seat) => seat.guestId !== null)) {
    throw new StateMutationError("Cannot delete an occupied table. Unseat guests first.");
  }

  return touch({
    ...chart,
    tables: chart.tables.filter((candidate) => candidate.id !== input.tableId),
  });
}

export function assignSeat(chart: ChartState, input: AssignSeatInput, validGuestIds: Set<string>): ChartState {
  if (!validGuestIds.has(input.guestId)) {
    throw new StateMutationError("Guest not found");
  }

  const tableIndex = chart.tables.findIndex((table) => table.id === input.tableId);
  if (tableIndex === -1) {
    throw new StateMutationError("Table not found");
  }

  const tables = chart.tables.map(copyTable);
  const table = tables[tableIndex];
  if (!table) {
    throw new StateMutationError("Table not found");
  }

  const seat = table.seats[input.seatIndex];
  if (!seat) {
    throw new StateMutationError("Seat not found");
  }

  const existingSeat = findGuestSeat(chart, input.guestId);
  if (existingSeat) {
    if (existingSeat.tableId === input.tableId && existingSeat.seatIndex === input.seatIndex) {
      return chart;
    }

    throw new StateMutationError("Guest is already seated elsewhere");
  }

  if (seat.guestId !== null) {
    throw new StateMutationError("Seat is already occupied");
  }

  table.seats[input.seatIndex] = { index: input.seatIndex, guestId: input.guestId };
  return touch({ ...chart, tables });
}

export function clearSeat(chart: ChartState, input: ClearSeatInput): ChartState {
  const tableIndex = chart.tables.findIndex((table) => table.id === input.tableId);
  if (tableIndex === -1) {
    throw new StateMutationError("Table not found");
  }

  const tables = chart.tables.map(copyTable);
  const table = tables[tableIndex];
  if (!table) {
    throw new StateMutationError("Table not found");
  }

  const seat = table.seats[input.seatIndex];
  if (!seat) {
    throw new StateMutationError("Seat not found");
  }

  if (seat.guestId === null) {
    return chart;
  }

  table.seats[input.seatIndex] = { index: input.seatIndex, guestId: null };
  return touch({ ...chart, tables });
}

function touch(chart: ChartState): ChartState {
  return { ...chart, updatedAt: new Date().toISOString() };
}

function createSeats(seatCount: number): SeatAssignment[] {
  return Array.from({ length: seatCount }, (_, index) => ({ index, guestId: null }));
}

function resizeSeats(seats: SeatAssignment[], seatCount: number): SeatAssignment[] {
  return Array.from({ length: seatCount }, (_, index) => ({
    index,
    guestId: seats[index]?.guestId ?? null,
  }));
}

function copyTable(table: SeatingTable): SeatingTable {
  return {
    ...table,
    seats: table.seats.map((seat) => ({ ...seat })),
  };
}

function findGuestSeat(chart: ChartState, guestId: string): { tableId: string; seatIndex: number } | null {
  for (const table of chart.tables) {
    for (const seat of table.seats) {
      if (seat.guestId === guestId) {
        return { tableId: table.id, seatIndex: seat.index };
      }
    }
  }

  return null;
}

function parseSeatCount(value: unknown): number {
  const seatCount = Number(value);
  if (!Number.isInteger(seatCount) || seatCount < MIN_SEATS || seatCount > MAX_SEATS) {
    throw new StateMutationError(`Seat count must be between ${MIN_SEATS} and ${MAX_SEATS}`);
  }

  return seatCount;
}

function clampSeatCount(value: unknown): number {
  const seatCount = Number(value);
  if (!Number.isInteger(seatCount)) {
    return 10;
  }

  return Math.min(Math.max(seatCount, MIN_SEATS), MAX_SEATS);
}

function parseShape(value: unknown): TableShape {
  if (!isTableShape(value)) {
    throw new StateMutationError("Table shape must be round or rectangle");
  }

  return value;
}

function isTableShape(value: unknown): value is TableShape {
  return value === "round" || value === "rectangle";
}

function normalizeTableName(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.slice(0, MAX_TABLE_NAME_LENGTH);
}

function parseCoordinate(value: unknown): number {
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate)) {
    throw new StateMutationError("Table position must be a finite number");
  }

  return Math.min(Math.max(Math.round(coordinate), 0), 5000);
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue) : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
