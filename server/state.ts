import { randomUUID } from "node:crypto";

import type {
  AssignSeatInput,
  BulkUpdateGuestsInput,
  ChartState,
  ClearSeatInput,
  CreateFloorPlanObjectInput,
  CreateTableInput,
  DeleteFloorPlanObjectInput,
  DeleteTableInput,
  FloorPlanObject,
  FloorPlanObjectKind,
  GuestMetadata,
  SeatAssignment,
  SeatPartyAtTableInput,
  SeatingTable,
  SetChartLockedInput,
  SetGuestIgnoredInput,
  SetTableLockedInput,
  TableShape,
  UpdateFloorPlanObjectInput,
  UpdateGuestMetadataInput,
  UpdateTableInput,
} from "../shared/types";

const MIN_SEATS = 1;
const MAX_SEATS = 32;
const MAX_TABLE_NAME_LENGTH = 48;
const MAX_TAGS_PER_GUEST = 12;
const MAX_TAG_LENGTH = 32;
const MAX_NOTE_LENGTH = 500;
const MAX_FLOOR_OBJECT_LABEL_LENGTH = 48;
const MIN_FLOOR_OBJECT_SIZE = 24;
const MAX_FLOOR_OBJECT_SIZE = 800;
const MAX_COORDINATE = 10000;

export class StateMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateMutationError";
  }
}

export function createEmptyChart(): ChartState {
  return {
    version: 3,
    locked: false,
    tables: [],
    floorPlanObjects: [],
    ignoredGuestIds: [],
    guestMetadata: {},
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeChartState(value: unknown, validGuestIds: Set<string>): ChartState {
  if (!isObject(value) || !Array.isArray(value.tables)) {
    return createEmptyChart();
  }

  const usedGuestIds = new Set<string>();
  const ignoredGuestIds = normalizeIgnoredGuestIds(value.ignoredGuestIds, validGuestIds);
  const guestMetadata = normalizeGuestMetadata(value.guestMetadata, validGuestIds);
  const floorPlanObjects = normalizeFloorPlanObjects(value.floorPlanObjects);
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
      locked: rawTable.locked === true,
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

        if (!validGuestIds.has(guestId) || usedGuestIds.has(guestId) || ignoredGuestIds.has(guestId)) {
          return;
        }

        table.seats[index] = { index, guestId };
        usedGuestIds.add(guestId);
      });
    }

    tables.push(table);
  });

  return {
    version: 3,
    locked: value.locked === true,
    tables,
    floorPlanObjects,
    ignoredGuestIds: [...ignoredGuestIds].sort(),
    guestMetadata,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

export function createTable(chart: ChartState, input: CreateTableInput): ChartState {
  assertChartEditable(chart);

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
    locked: false,
    seats: createSeats(seatCount),
  };

  return touch({ ...chart, tables: [...chart.tables, table] });
}

export function updateTable(chart: ChartState, input: UpdateTableInput): ChartState {
  assertChartEditable(chart);

  const tableIndex = chart.tables.findIndex((table) => table.id === input.tableId);
  if (tableIndex === -1) {
    throw new StateMutationError("Table not found");
  }

  const tables = chart.tables.map(copyTable);
  const table = tables[tableIndex];
  if (!table) {
    throw new StateMutationError("Table not found");
  }
  assertTableEditable(table);

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
  assertChartEditable(chart);

  const table = chart.tables.find((candidate) => candidate.id === input.tableId);
  if (!table) {
    throw new StateMutationError("Table not found");
  }
  assertTableEditable(table);

  if (table.seats.some((seat) => seat.guestId !== null)) {
    throw new StateMutationError("Cannot delete an occupied table. Unseat guests first.");
  }

  return touch({
    ...chart,
    tables: chart.tables.filter((candidate) => candidate.id !== input.tableId),
  });
}

export function assignSeat(chart: ChartState, input: AssignSeatInput, validGuestIds: Set<string>): ChartState {
  assertChartEditable(chart);

  if (!validGuestIds.has(input.guestId)) {
    throw new StateMutationError("Guest not found");
  }

  if (chart.ignoredGuestIds.includes(input.guestId)) {
    throw new StateMutationError("Guest is ignored and cannot be assigned to a seat");
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
  assertTableEditable(table);

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

export function setGuestIgnored(chart: ChartState, input: SetGuestIgnoredInput, validGuestIds: Set<string>): ChartState {
  assertChartEditable(chart);

  if (!validGuestIds.has(input.guestId)) {
    throw new StateMutationError("Guest not found");
  }

  const ignoredGuestIds = new Set(chart.ignoredGuestIds);
  if (input.ignored) {
    ignoredGuestIds.add(input.guestId);
  } else {
    ignoredGuestIds.delete(input.guestId);
  }

  let removedSeatedGuest = false;
  const tables = chart.tables.map((table) => ({
    ...table,
    seats: table.seats.map((seat) => {
      if (input.ignored && seat.guestId === input.guestId) {
        assertTableEditable(table);
        removedSeatedGuest = true;
        return { ...seat, guestId: null };
      }

      return { ...seat };
    }),
  }));

  const nextIgnoredGuestIds = [...ignoredGuestIds].sort();
  if (arraysEqual(chart.ignoredGuestIds, nextIgnoredGuestIds) && !removedSeatedGuest) {
    return chart;
  }

  return touch({ ...chart, tables, ignoredGuestIds: nextIgnoredGuestIds });
}

export function updateGuestMetadata(
  chart: ChartState,
  input: UpdateGuestMetadataInput,
  validGuestIds: Set<string>,
): ChartState {
  assertChartEditable(chart);

  if (!validGuestIds.has(input.guestId)) {
    throw new StateMutationError("Guest not found");
  }

  const currentMetadata = chart.guestMetadata[input.guestId] ?? emptyGuestMetadata();
  const nextMetadata: GuestMetadata = {
    tags: input.tags === undefined ? currentMetadata.tags : normalizeTags(input.tags),
    note: input.note === undefined ? currentMetadata.note : normalizeNote(input.note),
  };
  const guestMetadata = { ...chart.guestMetadata };

  if (nextMetadata.tags.length === 0 && nextMetadata.note.length === 0) {
    delete guestMetadata[input.guestId];
  } else {
    guestMetadata[input.guestId] = nextMetadata;
  }

  if (metadataEqual(currentMetadata, nextMetadata)) {
    return chart;
  }

  return touch({ ...chart, guestMetadata });
}

export function bulkUpdateGuests(chart: ChartState, input: BulkUpdateGuestsInput, validGuestIds: Set<string>): ChartState {
  assertChartEditable(chart);

  const guestIds = [...new Set(input.guestIds)].filter(Boolean);
  if (guestIds.length === 0) {
    throw new StateMutationError("Select at least one guest");
  }

  guestIds.forEach((guestId) => {
    if (!validGuestIds.has(guestId)) {
      throw new StateMutationError("Guest not found");
    }
  });

  const ignoredGuestIds = new Set(chart.ignoredGuestIds);
  const guestMetadata = { ...chart.guestMetadata };
  const addTag = input.addTag === undefined ? null : normalizeSingleTag(input.addTag);
  const removeTag = input.removeTag === undefined ? null : normalizeSingleTag(input.removeTag);
  let changed = false;

  guestIds.forEach((guestId) => {
    if (input.ignored === true && !ignoredGuestIds.has(guestId)) {
      ignoredGuestIds.add(guestId);
      changed = true;
    }
    if (input.ignored === false && ignoredGuestIds.delete(guestId)) {
      changed = true;
    }

    if (addTag || removeTag) {
      const metadata = guestMetadata[guestId] ?? emptyGuestMetadata();
      let tags = metadata.tags;
      if (addTag && !tags.includes(addTag)) {
        tags = normalizeTags([...tags, addTag]);
      }
      if (removeTag) {
        tags = tags.filter((tag) => tag !== removeTag);
      }

      if (!arraysEqual(metadata.tags, tags)) {
        changed = true;
        if (tags.length === 0 && metadata.note.length === 0) {
          delete guestMetadata[guestId];
        } else {
          guestMetadata[guestId] = { ...metadata, tags };
        }
      }
    }
  });

  let removedSeatedGuest = false;
  const tables = chart.tables.map((table) => ({
    ...table,
    seats: table.seats.map((seat) => {
      if (input.ignored === true && seat.guestId && ignoredGuestIds.has(seat.guestId)) {
        assertTableEditable(table);
        removedSeatedGuest = true;
        return { ...seat, guestId: null };
      }

      return { ...seat };
    }),
  }));

  if (!changed && !removedSeatedGuest) {
    return chart;
  }

  return touch({
    ...chart,
    tables,
    ignoredGuestIds: [...ignoredGuestIds].sort(),
    guestMetadata,
  });
}

export function seatPartyAtTable(
  chart: ChartState,
  input: SeatPartyAtTableInput,
  partyGuestIds: string[],
): ChartState {
  assertChartEditable(chart);

  const activeGuestIds = partyGuestIds.filter((guestId) => !chart.ignoredGuestIds.includes(guestId));
  if (activeGuestIds.length === 0) {
    throw new StateMutationError("Party has no active guests to seat");
  }

  const tableIndex = chart.tables.findIndex((table) => table.id === input.tableId);
  if (tableIndex === -1) {
    throw new StateMutationError("Table not found");
  }

  const activeGuestIdSet = new Set(activeGuestIds);
  const tables = chart.tables.map((table) => ({
    ...table,
    seats: table.seats.map((seat) => ({
      ...seat,
      guestId: seat.guestId && activeGuestIdSet.has(seat.guestId) ? null : seat.guestId,
    })),
  }));
  const targetTable = tables[tableIndex];
  if (!targetTable) {
    throw new StateMutationError("Table not found");
  }
  assertTableEditable(targetTable);

  tables.forEach((table) => {
    if (table.id !== targetTable.id && table.locked && table.seats.some((seat) => seat.guestId && activeGuestIdSet.has(seat.guestId))) {
      throw new StateMutationError("Cannot move a party member from a locked table");
    }
  });

  const openSeats = targetTable.seats.filter((seat) => seat.guestId === null);
  if (openSeats.length < activeGuestIds.length) {
    throw new StateMutationError(`Not enough open seats at ${targetTable.name} for this party`);
  }

  activeGuestIds.forEach((guestId, index) => {
    const seat = openSeats[index];
    if (!seat) {
      throw new StateMutationError("Not enough open seats for this party");
    }

    targetTable.seats[seat.index] = { index: seat.index, guestId };
  });

  return touch({ ...chart, tables });
}

export function clearSeat(chart: ChartState, input: ClearSeatInput): ChartState {
  assertChartEditable(chart);

  const tableIndex = chart.tables.findIndex((table) => table.id === input.tableId);
  if (tableIndex === -1) {
    throw new StateMutationError("Table not found");
  }

  const tables = chart.tables.map(copyTable);
  const table = tables[tableIndex];
  if (!table) {
    throw new StateMutationError("Table not found");
  }
  assertTableEditable(table);

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

export function setChartLocked(chart: ChartState, input: SetChartLockedInput): ChartState {
  if (chart.locked === input.locked) {
    return chart;
  }

  return touch({ ...chart, locked: input.locked });
}

export function setTableLocked(chart: ChartState, input: SetTableLockedInput): ChartState {
  const tableIndex = chart.tables.findIndex((table) => table.id === input.tableId);
  if (tableIndex === -1) {
    throw new StateMutationError("Table not found");
  }

  const tables = chart.tables.map(copyTable);
  const table = tables[tableIndex];
  if (!table) {
    throw new StateMutationError("Table not found");
  }

  if (table.locked === input.locked) {
    return chart;
  }

  table.locked = input.locked;
  return touch({ ...chart, tables });
}

export function createFloorPlanObject(chart: ChartState, input: CreateFloorPlanObjectInput): ChartState {
  assertChartEditable(chart);

  const kind = parseFloorPlanObjectKind(input.kind);
  const nextNumber = chart.floorPlanObjects.length + 1;
  const object: FloorPlanObject = {
    id: `floor-${randomUUID()}`,
    kind,
    label: normalizeFloorPlanObjectLabel(input.label, defaultFloorPlanObjectLabel(kind)),
    x: 120 + ((nextNumber - 1) % 4) * 180,
    y: 120 + Math.floor((nextNumber - 1) / 4) * 120,
    width: defaultFloorPlanObjectSize(kind).width,
    height: defaultFloorPlanObjectSize(kind).height,
  };

  return touch({ ...chart, floorPlanObjects: [...chart.floorPlanObjects, object] });
}

export function updateFloorPlanObject(chart: ChartState, input: UpdateFloorPlanObjectInput): ChartState {
  assertChartEditable(chart);

  const objectIndex = chart.floorPlanObjects.findIndex((object) => object.id === input.objectId);
  if (objectIndex === -1) {
    throw new StateMutationError("Floor plan object not found");
  }

  const floorPlanObjects = chart.floorPlanObjects.map((object) => ({ ...object }));
  const object = floorPlanObjects[objectIndex];
  if (!object) {
    throw new StateMutationError("Floor plan object not found");
  }

  if (input.kind !== undefined) {
    object.kind = parseFloorPlanObjectKind(input.kind);
  }
  if (input.label !== undefined) {
    object.label = normalizeFloorPlanObjectLabel(input.label, object.label);
  }
  if (input.x !== undefined) {
    object.x = parseCoordinate(input.x);
  }
  if (input.y !== undefined) {
    object.y = parseCoordinate(input.y);
  }
  if (input.width !== undefined) {
    object.width = parseFloorPlanObjectSize(input.width);
  }
  if (input.height !== undefined) {
    object.height = parseFloorPlanObjectSize(input.height);
  }

  return touch({ ...chart, floorPlanObjects });
}

export function deleteFloorPlanObject(chart: ChartState, input: DeleteFloorPlanObjectInput): ChartState {
  assertChartEditable(chart);

  const exists = chart.floorPlanObjects.some((object) => object.id === input.objectId);
  if (!exists) {
    throw new StateMutationError("Floor plan object not found");
  }

  return touch({
    ...chart,
    floorPlanObjects: chart.floorPlanObjects.filter((object) => object.id !== input.objectId),
  });
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

function assertChartEditable(chart: ChartState): void {
  if (chart.locked) {
    throw new StateMutationError("Chart is locked. Unlock it before making changes.");
  }
}

function assertTableEditable(table: SeatingTable): void {
  if (table.locked) {
    throw new StateMutationError(`${table.name} is locked. Unlock it before making changes.`);
  }
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

function normalizeIgnoredGuestIds(value: unknown, validGuestIds: Set<string>): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }

  return new Set(value.filter((guestId): guestId is string => typeof guestId === "string" && validGuestIds.has(guestId)));
}

function normalizeGuestMetadata(value: unknown, validGuestIds: Set<string>): Record<string, GuestMetadata> {
  if (!isObject(value)) {
    return {};
  }

  const metadata: Record<string, GuestMetadata> = {};
  Object.entries(value).forEach(([guestId, rawMetadata]) => {
    if (!validGuestIds.has(guestId) || !isObject(rawMetadata)) {
      return;
    }

    const tags = Array.isArray(rawMetadata.tags) ? normalizePersistedTags(rawMetadata.tags) : [];
    const note = normalizeNote(rawMetadata.note);
    if (tags.length > 0 || note.length > 0) {
      metadata[guestId] = { tags, note };
    }
  });

  return metadata;
}

function normalizeFloorPlanObjects(value: unknown): FloorPlanObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((rawObject, index): FloorPlanObject[] => {
    if (!isObject(rawObject) || !isFloorPlanObjectKind(rawObject.kind)) {
      return [];
    }

    const size = defaultFloorPlanObjectSize(rawObject.kind);
    return [{
      id: typeof rawObject.id === "string" && rawObject.id ? rawObject.id : `floor-${index + 1}`,
      kind: rawObject.kind,
      label: normalizeFloorPlanObjectLabel(rawObject.label, defaultFloorPlanObjectLabel(rawObject.kind)),
      x: finiteNumber(rawObject.x, 120 + index * 24),
      y: finiteNumber(rawObject.y, 120 + index * 24),
      width: clampFloorPlanObjectSize(rawObject.width, size.width),
      height: clampFloorPlanObjectSize(rawObject.height, size.height),
    }];
  });
}

function emptyGuestMetadata(): GuestMetadata {
  return { tags: [], note: "" };
}

function normalizeTags(values: unknown[]): string[] {
  const tags = values.map(normalizeSingleTag).filter(Boolean);
  return [...new Set(tags)].sort().slice(0, MAX_TAGS_PER_GUEST);
}

function normalizePersistedTags(values: unknown[]): string[] {
  const tags = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LENGTH))
    .filter(Boolean);
  return [...new Set(tags)].sort().slice(0, MAX_TAGS_PER_GUEST);
}

function normalizeSingleTag(value: unknown): string {
  if (typeof value !== "string") {
    throw new StateMutationError("Tag must be text");
  }

  const tag = value.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LENGTH);
  if (!tag) {
    throw new StateMutationError("Tag cannot be empty");
  }

  return tag;
}

function normalizeNote(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, MAX_NOTE_LENGTH);
}

function metadataEqual(first: GuestMetadata, second: GuestMetadata): boolean {
  return first.note === second.note && arraysEqual(first.tags, second.tags);
}

function arraysEqual(first: string[], second: string[]): boolean {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((value, index) => value === second[index]);
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

function parseFloorPlanObjectKind(value: unknown): FloorPlanObjectKind {
  if (!isFloorPlanObjectKind(value)) {
    throw new StateMutationError("Floor plan object type is invalid");
  }

  return value;
}

function isFloorPlanObjectKind(value: unknown): value is FloorPlanObjectKind {
  return value === "dance-floor"
    || value === "bar"
    || value === "dj"
    || value === "head-table"
    || value === "door"
    || value === "wall"
    || value === "label"
    || value === "blocked-area";
}

function defaultFloorPlanObjectLabel(kind: FloorPlanObjectKind): string {
  switch (kind) {
    case "dance-floor":
      return "Dance Floor";
    case "bar":
      return "Bar";
    case "dj":
      return "DJ";
    case "head-table":
      return "Head Table";
    case "door":
      return "Door";
    case "wall":
      return "Wall";
    case "label":
      return "Label";
    case "blocked-area":
      return "Blocked Area";
  }
}

function defaultFloorPlanObjectSize(kind: FloorPlanObjectKind): { width: number; height: number } {
  switch (kind) {
    case "dance-floor":
      return { width: 220, height: 160 };
    case "bar":
      return { width: 160, height: 72 };
    case "dj":
      return { width: 120, height: 72 };
    case "head-table":
      return { width: 260, height: 86 };
    case "door":
      return { width: 80, height: 42 };
    case "wall":
      return { width: 260, height: 24 };
    case "label":
      return { width: 140, height: 48 };
    case "blocked-area":
      return { width: 160, height: 120 };
  }
}

function normalizeFloorPlanObjectLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.slice(0, MAX_FLOOR_OBJECT_LABEL_LENGTH);
}

function parseFloorPlanObjectSize(value: unknown): number {
  const size = Number(value);
  if (!Number.isFinite(size)) {
    throw new StateMutationError("Floor plan object size must be a finite number");
  }

  return Math.min(Math.max(Math.round(size), MIN_FLOOR_OBJECT_SIZE), MAX_FLOOR_OBJECT_SIZE);
}

function clampFloorPlanObjectSize(value: unknown, fallback: number): number {
  const size = Number(value);
  if (!Number.isFinite(size)) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(size), MIN_FLOOR_OBJECT_SIZE), MAX_FLOOR_OBJECT_SIZE);
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

  return Math.min(Math.max(Math.round(coordinate), 0), MAX_COORDINATE);
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue) : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
