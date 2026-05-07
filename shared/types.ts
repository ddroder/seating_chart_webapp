export type TableShape = "round" | "rectangle";

export type FloorPlanObjectKind = "dance-floor" | "bar" | "dj" | "head-table" | "door" | "wall" | "label" | "blocked-area";

export type GuestKind = "primary" | "partner" | "child";

export interface Guest {
  id: string;
  partyId: string;
  fullName: string;
  displayName: string;
  kind: GuestKind;
  relationship: string;
}

export interface GuestParty {
  id: string;
  label: string;
  relationship: string;
  guestIds: string[];
}

export interface SeatAssignment {
  index: number;
  guestId: string | null;
}

export interface SeatingTable {
  id: string;
  name: string;
  shape: TableShape;
  seatCount: number;
  x: number;
  y: number;
  locked: boolean;
  seats: SeatAssignment[];
}

export interface FloorPlanObject {
  id: string;
  kind: FloorPlanObjectKind;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuestMetadata {
  tags: string[];
  note: string;
}

export interface ChartState {
  version: 3;
  locked: boolean;
  tables: SeatingTable[];
  floorPlanObjects: FloorPlanObject[];
  ignoredGuestIds: string[];
  guestMetadata: Record<string, GuestMetadata>;
  updatedAt: string;
}

export interface HistoryEntrySummary {
  id: string;
  timestamp: string;
  action: string;
  tableCount: number;
  activeGuestCount: number;
  seatedGuestCount: number;
  ignoredGuestCount: number;
}

export interface AppSnapshot {
  guests: Guest[];
  parties: GuestParty[];
  chart: ChartState;
  connectedUsers: number;
}

export interface CreateTableInput {
  shape: TableShape;
  seatCount: number;
}

export interface UpdateTableInput {
  tableId: string;
  name?: string;
  shape?: TableShape;
  seatCount?: number;
  x?: number;
  y?: number;
}

export interface DeleteTableInput {
  tableId: string;
}

export interface AssignSeatInput {
  tableId: string;
  seatIndex: number;
  guestId: string;
}

export interface ClearSeatInput {
  tableId: string;
  seatIndex: number;
}

export interface SetGuestIgnoredInput {
  guestId: string;
  ignored: boolean;
}

export interface UpdateGuestMetadataInput {
  guestId: string;
  tags?: string[];
  note?: string;
}

export interface BulkUpdateGuestsInput {
  guestIds: string[];
  ignored?: boolean;
  addTag?: string;
  removeTag?: string;
}

export interface SeatPartyAtTableInput {
  partyId: string;
  tableId: string;
}

export interface RestoreHistoryInput {
  historyId: string;
}

export interface SetChartLockedInput {
  locked: boolean;
}

export interface SetTableLockedInput {
  tableId: string;
  locked: boolean;
}

export interface CreateFloorPlanObjectInput {
  kind: FloorPlanObjectKind;
  label?: string;
}

export interface UpdateFloorPlanObjectInput {
  objectId: string;
  kind?: FloorPlanObjectKind;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DeleteFloorPlanObjectInput {
  objectId: string;
}

export type MutationAck =
  | { ok: true }
  | { ok: false; error: string };

export interface ServerToClientEvents {
  snapshot: (snapshot: AppSnapshot) => void;
}

export interface ClientToServerEvents {
  "table:create": (input: CreateTableInput, ack: (result: MutationAck) => void) => void;
  "table:update": (input: UpdateTableInput, ack: (result: MutationAck) => void) => void;
  "table:delete": (input: DeleteTableInput, ack: (result: MutationAck) => void) => void;
  "seat:assign": (input: AssignSeatInput, ack: (result: MutationAck) => void) => void;
  "seat:clear": (input: ClearSeatInput, ack: (result: MutationAck) => void) => void;
  "guest:ignore": (input: SetGuestIgnoredInput, ack: (result: MutationAck) => void) => void;
  "guest:metadata:update": (input: UpdateGuestMetadataInput, ack: (result: MutationAck) => void) => void;
  "guests:bulkUpdate": (input: BulkUpdateGuestsInput, ack: (result: MutationAck) => void) => void;
  "party:seatAtTable": (input: SeatPartyAtTableInput, ack: (result: MutationAck) => void) => void;
  "history:restore": (input: RestoreHistoryInput, ack: (result: MutationAck) => void) => void;
  "chart:lock": (input: SetChartLockedInput, ack: (result: MutationAck) => void) => void;
  "table:lock": (input: SetTableLockedInput, ack: (result: MutationAck) => void) => void;
  "floor:create": (input: CreateFloorPlanObjectInput, ack: (result: MutationAck) => void) => void;
  "floor:update": (input: UpdateFloorPlanObjectInput, ack: (result: MutationAck) => void) => void;
  "floor:delete": (input: DeleteFloorPlanObjectInput, ack: (result: MutationAck) => void) => void;
}
