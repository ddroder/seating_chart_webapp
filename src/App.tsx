import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";

import type {
  AppSnapshot,
  ClearSeatInput,
  ClientToServerEvents,
  Guest,
  MutationAck,
  SeatAssignment,
  SeatingTable,
  ServerToClientEvents,
  TableShape,
  UpdateTableInput,
} from "../shared/types";

type SeatingSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ConnectionState = "connecting" | "connected" | "offline";
type GuestFilter = "unseated" | "all" | "seated";

interface GuestAssignment {
  tableId: string;
  tableName: string;
  seatIndex: number;
}

interface DragState {
  tableId: string;
  startPointerX: number;
  startPointerY: number;
  startX: number;
  startY: number;
}

const ROUND_STAGE_SIZE = 320;
const RECT_STAGE_WIDTH = 380;
const RECT_STAGE_HEIGHT = 280;

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [socket, setSocket] = useState<SeatingSocket | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedGuestId, setSelectedGuestId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [guestFilter, setGuestFilter] = useState<GuestFilter>("unseated");
  const [newTableShape, setNewTableShape] = useState<TableShape>("round");
  const [newTableSeats, setNewTableSeats] = useState(10);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({});
  const localPositionsRef = useRef(localPositions);

  useEffect(() => {
    localPositionsRef.current = localPositions;
  }, [localPositions]);

  useEffect(() => {
    const nextSocket: SeatingSocket = io();
    setSocket(nextSocket);

    nextSocket.on("connect", () => {
      setConnectionState("connected");
    });
    nextSocket.on("disconnect", () => {
      setConnectionState("offline");
    });
    nextSocket.on("snapshot", (nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });

    void fetch("/api/bootstrap")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Unable to load initial seating chart");
        }
        return response.json() as Promise<AppSnapshot>;
      })
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unable to load initial seating chart";
        setNotice(message);
      });

    return () => {
      nextSocket.close();
    };
  }, []);

  useEffect(() => {
    if (!dragState || !socket) {
      return;
    }

    const activeDrag = dragState;
    const activeSocket = socket;

    function handlePointerMove(event: globalThis.PointerEvent) {
      const x = Math.max(0, activeDrag.startX + event.clientX - activeDrag.startPointerX);
      const y = Math.max(0, activeDrag.startY + event.clientY - activeDrag.startPointerY);
      setLocalPositions((current) => ({ ...current, [activeDrag.tableId]: { x, y } }));
    }

    function handlePointerUp() {
      const position = localPositionsRef.current[activeDrag.tableId] ?? { x: activeDrag.startX, y: activeDrag.startY };
      activeSocket.emit("table:update", { tableId: activeDrag.tableId, x: position.x, y: position.y }, handleAck);
      setLocalPositions((current) => {
        const next = { ...current };
        delete next[activeDrag.tableId];
        return next;
      });
      setDragState(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, socket]);

  const guestsById = new Map(snapshot?.guests.map((guest) => [guest.id, guest]) ?? []);
  const assignments = buildAssignments(snapshot?.chart.tables ?? []);
  const seatedGuestIds = new Set(assignments.keys());
  const selectedGuest = selectedGuestId ? guestsById.get(selectedGuestId) ?? null : null;
  const seatedCount = seatedGuestIds.size;
  const totalGuests = snapshot?.guests.length ?? 0;

  function handleAck(result: MutationAck) {
    if (result.ok) {
      setNotice(null);
      return;
    }

    setNotice(result.error);
  }

  function createNewTable() {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("table:create", { shape: newTableShape, seatCount: newTableSeats }, handleAck);
  }

  function updateTable(input: UpdateTableInput) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("table:update", input, handleAck);
  }

  function deleteTable(tableId: string) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("table:delete", { tableId }, handleAck);
  }

  function clearSeat(input: ClearSeatInput) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("seat:clear", input, handleAck);
  }

  function clearGuest(guestId: string) {
    const assignment = assignments.get(guestId);
    if (!assignment) {
      return;
    }

    clearSeat({ tableId: assignment.tableId, seatIndex: assignment.seatIndex });
  }

  function assignSeat(tableId: string, seat: SeatAssignment) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    if (seat.guestId) {
      setSelectedGuestId(seat.guestId);
      return;
    }

    if (!selectedGuestId) {
      setNotice("Select an unseated guest first, then choose an empty seat");
      return;
    }

    if (seatedGuestIds.has(selectedGuestId)) {
      setNotice("Selected guest is already seated. Unseat them before moving them.");
      return;
    }

    socket.emit("seat:assign", { tableId, seatIndex: seat.index, guestId: selectedGuestId }, handleAck);
  }

  function startTableDrag(table: SeatingTable, event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    setDragState({
      tableId: table.id,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: localPositions[table.id]?.x ?? table.x,
      startY: localPositions[table.id]?.y ?? table.y,
    });
  }

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <div>
          <p className="eyebrow">Seating Chart</p>
          <h1>Loading guest list and shared chart...</h1>
          {notice ? <p className="error-text">{notice}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Shared local seating chart</p>
          <h1>Wedding Seating Studio</h1>
        </div>
        <div className="topbar-stats" aria-label="chart status">
          <span className={`status-pill ${connectionState}`}>{connectionState}</span>
          <span>{snapshot.connectedUsers} connected</span>
          <span>{seatedCount} / {totalGuests} seated</span>
        </div>
      </header>

      {notice ? (
        <section className="notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </section>
      ) : null}

      <section className="workspace">
        <aside className="guest-panel" aria-label="guest list">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Guests</p>
              <h2>{snapshot.parties.length} parties</h2>
            </div>
            {selectedGuest ? (
              <button type="button" className="ghost-button" onClick={() => setSelectedGuestId(null)}>
                Clear selection
              </button>
            ) : null}
          </div>

          <label className="field-label" htmlFor="guest-search">Search guests</label>
          <input
            id="guest-search"
            className="text-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, party, relationship"
          />

          <div className="segmented-control" aria-label="guest filter">
            <button type="button" className={guestFilter === "unseated" ? "active" : ""} onClick={() => setGuestFilter("unseated")}>Unseated</button>
            <button type="button" className={guestFilter === "all" ? "active" : ""} onClick={() => setGuestFilter("all")}>All</button>
            <button type="button" className={guestFilter === "seated" ? "active" : ""} onClick={() => setGuestFilter("seated")}>Seated</button>
          </div>

          {selectedGuest ? (
            <div className="selected-card">
              <span>Selected</span>
              <strong>{selectedGuest.displayName}</strong>
              {assignments.has(selectedGuest.id) ? (
                <button type="button" onClick={() => clearGuest(selectedGuest.id)}>Unseat guest</button>
              ) : (
                <small>Click any empty seat to assign.</small>
              )}
            </div>
          ) : null}

          <GuestList
            snapshot={snapshot}
            guestsById={guestsById}
            assignments={assignments}
            seatedGuestIds={seatedGuestIds}
            filter={guestFilter}
            search={deferredSearch}
            selectedGuestId={selectedGuestId}
            onSelectGuest={setSelectedGuestId}
            onClearGuest={clearGuest}
          />
        </aside>

        <section className="chart-panel" aria-label="seating chart canvas">
          <div className="chart-toolbar">
            <div>
              <p className="eyebrow">Tables</p>
              <h2>{snapshot.chart.tables.length} tables</h2>
            </div>
            <div className="new-table-controls">
              <label>
                Shape
                <select value={newTableShape} onChange={(event) => setNewTableShape(event.target.value as TableShape)}>
                  <option value="round">Round</option>
                  <option value="rectangle">Rectangle</option>
                </select>
              </label>
              <label>
                Seats
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={newTableSeats}
                  onChange={(event) => setNewTableSeats(Number(event.target.value))}
                />
              </label>
              <button type="button" className="primary-button" onClick={createNewTable}>Add table</button>
            </div>
          </div>

          <div className="canvas">
            {snapshot.chart.tables.length === 0 ? (
              <div className="empty-canvas">
                <p className="eyebrow">Start here</p>
                <h2>Add a round or rectangle table.</h2>
                <p>Select guests from the left, then click empty seats to place them.</p>
              </div>
            ) : null}

            {snapshot.chart.tables.map((table) => (
              <TableCard
                key={table.id}
                table={table}
                position={localPositions[table.id] ?? { x: table.x, y: table.y }}
                guestsById={guestsById}
                selectedGuestId={selectedGuestId}
                onStartDrag={startTableDrag}
                onUpdateTable={updateTable}
                onDeleteTable={deleteTable}
                onSeatClick={assignSeat}
                onClearSeat={clearSeat}
                onLocalError={setNotice}
              />
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

interface GuestListProps {
  snapshot: AppSnapshot;
  guestsById: Map<string, Guest>;
  assignments: Map<string, GuestAssignment>;
  seatedGuestIds: Set<string>;
  filter: GuestFilter;
  search: string;
  selectedGuestId: string | null;
  onSelectGuest: (guestId: string) => void;
  onClearGuest: (guestId: string) => void;
}

function GuestList(props: GuestListProps) {
  const query = props.search.trim().toLowerCase();
  const visibleParties = props.snapshot.parties
    .map((party) => {
      const guests = party.guestIds
        .map((guestId) => props.guestsById.get(guestId))
        .filter(isGuest)
        .filter((guest) => {
          const isSeated = props.seatedGuestIds.has(guest.id);
          if (props.filter === "unseated" && isSeated) {
            return false;
          }
          if (props.filter === "seated" && !isSeated) {
            return false;
          }
          if (!query) {
            return true;
          }

          return `${guest.displayName} ${guest.fullName} ${party.label} ${party.relationship}`.toLowerCase().includes(query);
        });

      return { party, guests };
    })
    .filter(({ guests }) => guests.length > 0);

  if (visibleParties.length === 0) {
    return <p className="empty-list">No guests match this filter.</p>;
  }

  return (
    <div className="guest-list">
      {visibleParties.map(({ party, guests }) => (
        <section key={party.id} className="party-card">
          <div className="party-heading">
            <strong>{party.label}</strong>
            <span>{party.relationship}</span>
          </div>
          <div className="guest-stack">
            {guests.map((guest) => {
              const assignment = props.assignments.get(guest.id);
              const isSelected = props.selectedGuestId === guest.id;
              return (
                <div key={guest.id} className={`guest-row ${isSelected ? "selected" : ""}`}>
                  <button type="button" onClick={() => props.onSelectGuest(guest.id)}>
                    <span>{guest.displayName}</span>
                    <small>{guest.kind}{assignment ? ` - ${assignment.tableName}, seat ${assignment.seatIndex + 1}` : " - unseated"}</small>
                  </button>
                  {assignment ? (
                    <button type="button" className="mini-button" onClick={() => props.onClearGuest(guest.id)}>
                      Unseat
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

interface TableCardProps {
  table: SeatingTable;
  position: { x: number; y: number };
  guestsById: Map<string, Guest>;
  selectedGuestId: string | null;
  onStartDrag: (table: SeatingTable, event: PointerEvent<HTMLButtonElement>) => void;
  onUpdateTable: (input: UpdateTableInput) => void;
  onDeleteTable: (tableId: string) => void;
  onSeatClick: (tableId: string, seat: SeatAssignment) => void;
  onClearSeat: (input: ClearSeatInput) => void;
  onLocalError: (message: string) => void;
}

function TableCard(props: TableCardProps) {
  const [draftName, setDraftName] = useState(props.table.name);
  const [draftSeatCount, setDraftSeatCount] = useState(String(props.table.seatCount));
  const occupiedCount = props.table.seats.filter((seat) => seat.guestId !== null).length;
  const minimumSeatCount = props.table.seats.reduce((minimum, seat) => {
    if (!seat.guestId) {
      return minimum;
    }

    return Math.max(minimum, seat.index + 1);
  }, 1);

  useEffect(() => {
    setDraftName(props.table.name);
  }, [props.table.name]);

  useEffect(() => {
    setDraftSeatCount(String(props.table.seatCount));
  }, [props.table.seatCount]);

  function commitName() {
    if (draftName.trim() !== props.table.name) {
      props.onUpdateTable({ tableId: props.table.id, name: draftName });
    }
  }

  function commitSeatCount() {
    const nextSeatCount = Number(draftSeatCount);
    if (!Number.isInteger(nextSeatCount) || nextSeatCount < 1 || nextSeatCount > 32) {
      props.onLocalError("Seat count must be a whole number between 1 and 32");
      setDraftSeatCount(String(props.table.seatCount));
      return;
    }

    if (nextSeatCount < minimumSeatCount) {
      props.onLocalError(`Cannot reduce below ${minimumSeatCount}; a removed seat is occupied.`);
      setDraftSeatCount(String(props.table.seatCount));
      return;
    }

    if (nextSeatCount !== props.table.seatCount) {
      props.onUpdateTable({ tableId: props.table.id, seatCount: nextSeatCount });
    }
  }

  return (
    <article
      className={`table-card ${props.table.shape}`}
      style={{ left: props.position.x, top: props.position.y }}
    >
      <div className="table-card-header">
        <button type="button" className="drag-handle" onPointerDown={(event) => props.onStartDrag(props.table, event)}>
          Drag
        </button>
        <input
          className="table-name-input"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          aria-label="table name"
        />
        <button
          type="button"
          className="danger-button"
          disabled={occupiedCount > 0}
          title={occupiedCount > 0 ? "Unseat guests before deleting this table" : "Delete table"}
          onClick={() => props.onDeleteTable(props.table.id)}
        >
          Delete
        </button>
      </div>

      <div className="table-settings">
        <label>
          Shape
          <select
            value={props.table.shape}
            onChange={(event) => props.onUpdateTable({ tableId: props.table.id, shape: event.target.value as TableShape })}
          >
            <option value="round">Round</option>
            <option value="rectangle">Rectangle</option>
          </select>
        </label>
        <label>
          Seats
          <input
            type="number"
            min={minimumSeatCount}
            max={32}
            value={draftSeatCount}
            onChange={(event) => setDraftSeatCount(event.target.value)}
            onBlur={commitSeatCount}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <span>{occupiedCount} occupied</span>
      </div>

      <div className={`table-stage ${props.table.shape}`}>
        <div className={`table-surface ${props.table.shape}`}>
          <strong>{props.table.name}</strong>
          <span>{props.table.seatCount} seats</span>
        </div>
        {props.table.seats.map((seat) => {
          const guest = seat.guestId ? props.guestsById.get(seat.guestId) ?? null : null;
          return (
            <SeatButton
              key={seat.index}
              table={props.table}
              seat={seat}
              guest={guest}
              selectedGuestId={props.selectedGuestId}
              onSeatClick={props.onSeatClick}
              onClearSeat={props.onClearSeat}
            />
          );
        })}
      </div>
    </article>
  );
}

interface SeatButtonProps {
  table: SeatingTable;
  seat: SeatAssignment;
  guest: Guest | null;
  selectedGuestId: string | null;
  onSeatClick: (tableId: string, seat: SeatAssignment) => void;
  onClearSeat: (input: ClearSeatInput) => void;
}

function SeatButton(props: SeatButtonProps) {
  const isSelected = props.guest?.id === props.selectedGuestId;
  const seatLabel = props.guest?.displayName ?? `Seat ${props.seat.index + 1}`;
  return (
    <div
      className={`seat-button ${props.guest ? "occupied" : "empty"} ${isSelected ? "selected" : ""}`}
      style={seatStyle(props.table, props.seat.index)}
    >
      <button
        type="button"
        className="seat-main"
        title={props.guest?.fullName ?? "Empty seat"}
        onClick={() => props.onSeatClick(props.table.id, props.seat)}
      >
        <span>{seatLabel}</span>
        <small>{props.seat.index + 1}</small>
      </button>
      {props.guest ? (
        <button
          type="button"
          className="seat-clear"
          title="Unseat guest"
          onClick={() => props.onClearSeat({ tableId: props.table.id, seatIndex: props.seat.index })}
        >
          x
        </button>
      ) : null}
    </div>
  );
}

function buildAssignments(tables: SeatingTable[]): Map<string, GuestAssignment> {
  const assignments = new Map<string, GuestAssignment>();
  tables.forEach((table) => {
    table.seats.forEach((seat) => {
      if (!seat.guestId) {
        return;
      }

      assignments.set(seat.guestId, {
        tableId: table.id,
        tableName: table.name,
        seatIndex: seat.index,
      });
    });
  });

  return assignments;
}

function seatStyle(table: SeatingTable, index: number): CSSProperties {
  if (table.shape === "round") {
    const center = ROUND_STAGE_SIZE / 2;
    const radius = 124;
    const angle = -Math.PI / 2 + (index / table.seatCount) * Math.PI * 2;
    return {
      left: center + Math.cos(angle) * radius,
      top: center + Math.sin(angle) * radius,
    };
  }

  const width = RECT_STAGE_WIDTH - 64;
  const height = RECT_STAGE_HEIGHT - 64;
  const leftOffset = 32;
  const topOffset = 32;
  const perimeter = 2 * (width + height);
  const distance = (index / table.seatCount) * perimeter;

  if (distance <= width) {
    return { left: leftOffset + distance, top: topOffset };
  }

  if (distance <= width + height) {
    return { left: leftOffset + width, top: topOffset + distance - width };
  }

  if (distance <= width * 2 + height) {
    return { left: leftOffset + width - (distance - width - height), top: topOffset + height };
  }

  return { left: leftOffset, top: topOffset + height - (distance - width * 2 - height) };
}

function isGuest(guest: Guest | undefined): guest is Guest {
  return guest !== undefined;
}
