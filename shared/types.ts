export type TableShape = "round" | "rectangle";

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
  seats: SeatAssignment[];
}

export interface ChartState {
  version: 1;
  tables: SeatingTable[];
  ignoredGuestIds: string[];
  updatedAt: string;
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
}
