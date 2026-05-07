import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";

import type {
  AppSnapshot,
  BulkUpdateGuestsInput,
  ClearSeatInput,
  ClientToServerEvents,
  Guest,
  GuestMetadata,
  GuestParty,
  HistoryEntrySummary,
  MutationAck,
  SeatAssignment,
  SeatingTable,
  ServerToClientEvents,
  TableShape,
  UpdateGuestMetadataInput,
  UpdateTableInput,
} from "../shared/types";

type SeatingSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ConnectionState = "connecting" | "connected" | "offline";
type GuestFilter = "unseated" | "all" | "seated" | "ignored";

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

interface PrintOptions {
  includeIgnored: boolean;
  includeUnseated: boolean;
  includeNotes: boolean;
  compact: boolean;
}

const ROUND_STAGE_SIZE = 320;
const RECT_STAGE_WIDTH = 380;
const RECT_STAGE_HEIGHT = 280;
const TAG_PRESETS = ["vendor", "family", "wedding party", "do not seat near", "needs aisle", "child", "high priority"];
const EMPTY_METADATA: GuestMetadata = { tags: [], note: "" };

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [socket, setSocket] = useState<SeatingSocket | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedGuestId, setSelectedGuestId] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selectedGuestIds, setSelectedGuestIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [guestFilter, setGuestFilter] = useState<GuestFilter>("unseated");
  const [newTableShape, setNewTableShape] = useState<TableShape>("round");
  const [newTableSeats, setNewTableSeats] = useState(10);
  const [bulkTag, setBulkTag] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntrySummary[]>([]);
  const [printMode, setPrintMode] = useState(false);
  const [printOptions, setPrintOptions] = useState<PrintOptions>({
    includeIgnored: false,
    includeUnseated: true,
    includeNotes: false,
    compact: false,
  });
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
  const partiesById = new Map(snapshot?.parties.map((party) => [party.id, party]) ?? []);
  const assignments = buildAssignments(snapshot?.chart.tables ?? []);
  const seatedGuestIds = new Set(assignments.keys());
  const ignoredGuestIds = new Set(snapshot?.chart.ignoredGuestIds ?? []);
  const metadataByGuestId = snapshot?.chart.guestMetadata ?? {};
  const selectedGuest = selectedGuestId ? guestsById.get(selectedGuestId) ?? null : null;
  const selectedGuestIgnored = selectedGuestId ? ignoredGuestIds.has(selectedGuestId) : false;
  const selectedGuestMetadata = selectedGuestId ? metadataByGuestId[selectedGuestId] ?? EMPTY_METADATA : EMPTY_METADATA;
  const selectedTable = selectedTableId ? snapshot?.chart.tables.find((table) => table.id === selectedTableId) ?? null : null;
  const seatedCount = [...seatedGuestIds].filter((guestId) => !ignoredGuestIds.has(guestId)).length;
  const ignoredCount = ignoredGuestIds.size;
  const totalGuests = (snapshot?.guests.length ?? 0) - ignoredCount;
  const tagOptions = buildTagOptions(metadataByGuestId);

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

  function setGuestIgnored(guestId: string, ignored: boolean) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("guest:ignore", { guestId, ignored }, handleAck);
  }

  function updateGuestMetadata(input: UpdateGuestMetadataInput) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("guest:metadata:update", input, handleAck);
  }

  function bulkUpdateGuests(input: Omit<BulkUpdateGuestsInput, "guestIds">) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    const guestIds = [...selectedGuestIds];
    if (guestIds.length === 0) {
      setNotice("Select at least one guest first");
      return;
    }

    socket.emit("guests:bulkUpdate", { guestIds, ...input }, handleAck);
  }

  function seatPartyAtSelectedTable(partyId: string) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }
    if (!selectedTableId) {
      setNotice("Select a destination table first");
      return;
    }

    socket.emit("party:seatAtTable", { partyId, tableId: selectedTableId }, handleAck);
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

    if (ignoredGuestIds.has(selectedGuestId)) {
      setNotice("Selected guest is ignored. Include them before assigning a seat.");
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

  function toggleGuestSelection(guestId: string) {
    setSelectedGuestIds((current) => {
      const next = new Set(current);
      if (next.has(guestId)) {
        next.delete(guestId);
      } else {
        next.add(guestId);
      }
      return next;
    });
  }

  function selectGuestIds(guestIds: string[]) {
    setSelectedGuestIds((current) => {
      const next = new Set(current);
      guestIds.forEach((guestId) => next.add(guestId));
      return next;
    });
  }

  async function loadHistory() {
    try {
      const response = await fetch("/api/history");
      if (!response.ok) {
        throw new Error("Unable to load history");
      }

      setHistoryEntries((await response.json()) as HistoryEntrySummary[]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load history";
      setNotice(message);
    }
  }

  function restoreHistory(historyId: string) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }
    if (!window.confirm("Restore this snapshot? A safety snapshot of the current chart will be saved first.")) {
      return;
    }

    socket.emit("history:restore", { historyId }, (result) => {
      handleAck(result);
      if (result.ok) {
        void loadHistory();
      }
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

  if (printMode) {
    return (
      <PrintView
        snapshot={snapshot}
        guestsById={guestsById}
        partiesById={partiesById}
        assignments={assignments}
        ignoredGuestIds={ignoredGuestIds}
        metadataByGuestId={metadataByGuestId}
        options={printOptions}
        onChangeOptions={setPrintOptions}
        onBack={() => setPrintMode(false)}
      />
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
          <span>{ignoredCount} ignored</span>
          <button type="button" className="ghost-button" onClick={() => setPrintMode(true)}>Print / export</button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setHistoryOpen((open) => !open);
              void loadHistory();
            }}
          >
            History
          </button>
        </div>
      </header>

      {notice ? (
        <section className="notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </section>
      ) : null}

      {historyOpen ? (
        <HistoryPanel entries={historyEntries} onRefresh={loadHistory} onRestore={restoreHistory} />
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
            placeholder="Name, party, relationship, tag, note"
          />

          <div className="segmented-control" aria-label="guest filter">
            <button type="button" className={guestFilter === "unseated" ? "active" : ""} onClick={() => setGuestFilter("unseated")}>Unseated</button>
            <button type="button" className={guestFilter === "all" ? "active" : ""} onClick={() => setGuestFilter("all")}>All</button>
            <button type="button" className={guestFilter === "seated" ? "active" : ""} onClick={() => setGuestFilter("seated")}>Seated</button>
            <button type="button" className={guestFilter === "ignored" ? "active" : ""} onClick={() => setGuestFilter("ignored")}>Ignored</button>
          </div>

          {selectedGuestIds.size > 0 ? (
            <BulkActionBar
              selectedCount={selectedGuestIds.size}
              bulkTag={bulkTag}
              onBulkTagChange={setBulkTag}
              onClearSelection={() => setSelectedGuestIds(new Set())}
              onIgnore={() => bulkUpdateGuests({ ignored: true })}
              onInclude={() => bulkUpdateGuests({ ignored: false })}
              onAddTag={() => {
                bulkUpdateGuests({ addTag: bulkTag });
                setBulkTag("");
              }}
            />
          ) : null}

          {selectedGuest ? (
            <div className="selected-card">
              <span>Selected</span>
              <strong>{selectedGuest.displayName}</strong>
              {selectedGuestIgnored ? (
                <>
                  <small>Ignored guests are excluded from seating progress and cannot be assigned.</small>
                  <button type="button" onClick={() => setGuestIgnored(selectedGuest.id, false)}>Include guest</button>
                </>
              ) : (
                <>
                  {assignments.has(selectedGuest.id) ? (
                    <button type="button" onClick={() => clearGuest(selectedGuest.id)}>Unseat guest</button>
                  ) : (
                    <small>Click any empty seat to assign.</small>
                  )}
                  <button type="button" onClick={() => setGuestIgnored(selectedGuest.id, true)}>Ignore guest</button>
                </>
              )}
              <MetadataEditor
                guest={selectedGuest}
                metadata={selectedGuestMetadata}
                tagOptions={tagOptions}
                onUpdate={updateGuestMetadata}
              />
            </div>
          ) : null}

          {selectedTable ? (
            <div className="selected-table-card">
              <span>Party seating destination</span>
              <strong>{selectedTable.name}</strong>
              <small>{selectedTable.seats.filter((seat) => seat.guestId === null).length} currently open seats</small>
              <button type="button" className="ghost-button" onClick={() => setSelectedTableId(null)}>Clear table</button>
            </div>
          ) : null}

          <GuestList
            snapshot={snapshot}
            guestsById={guestsById}
            assignments={assignments}
            seatedGuestIds={seatedGuestIds}
            ignoredGuestIds={ignoredGuestIds}
            metadataByGuestId={metadataByGuestId}
            selectedGuestIds={selectedGuestIds}
            selectedTable={selectedTable}
            filter={guestFilter}
            search={deferredSearch}
            selectedGuestId={selectedGuestId}
            onSelectGuest={setSelectedGuestId}
            onClearGuest={clearGuest}
            onSetGuestIgnored={setGuestIgnored}
            onToggleGuestSelection={toggleGuestSelection}
            onSelectGuestIds={selectGuestIds}
            onSeatParty={seatPartyAtSelectedTable}
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
                selectedTableId={selectedTableId}
                onSelectTable={setSelectedTableId}
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

interface HistoryPanelProps {
  entries: HistoryEntrySummary[];
  onRefresh: () => void;
  onRestore: (historyId: string) => void;
}

function HistoryPanel(props: HistoryPanelProps) {
  return (
    <section className="history-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Version history</p>
          <h2>{props.entries.length} snapshots</h2>
        </div>
        <button type="button" className="ghost-button" onClick={props.onRefresh}>Refresh</button>
      </div>
      {props.entries.length === 0 ? (
        <p className="empty-list">No snapshots yet. The next saved edit will create one.</p>
      ) : (
        <div className="history-list">
          {props.entries.slice(0, 50).map((entry) => (
            <article key={entry.id} className="history-entry">
              <div>
                <strong>{new Date(entry.timestamp).toLocaleString()}</strong>
                <small>{entry.action} - {entry.seatedGuestCount} / {entry.activeGuestCount} seated, {entry.ignoredGuestCount} ignored, {entry.tableCount} tables</small>
              </div>
              <button type="button" className="mini-button" onClick={() => props.onRestore(entry.id)}>Restore</button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

interface BulkActionBarProps {
  selectedCount: number;
  bulkTag: string;
  onBulkTagChange: (tag: string) => void;
  onClearSelection: () => void;
  onIgnore: () => void;
  onInclude: () => void;
  onAddTag: () => void;
}

function BulkActionBar(props: BulkActionBarProps) {
  return (
    <div className="bulk-action-bar">
      <strong>{props.selectedCount} selected</strong>
      <div className="bulk-buttons">
        <button type="button" onClick={props.onIgnore}>Ignore</button>
        <button type="button" onClick={props.onInclude}>Include</button>
        <button type="button" onClick={props.onClearSelection}>Clear</button>
      </div>
      <div className="bulk-tag-row">
        <input value={props.bulkTag} onChange={(event) => props.onBulkTagChange(event.target.value)} placeholder="Tag selected" />
        <button type="button" onClick={props.onAddTag}>Add tag</button>
      </div>
    </div>
  );
}

interface MetadataEditorProps {
  guest: Guest;
  metadata: GuestMetadata;
  tagOptions: string[];
  onUpdate: (input: UpdateGuestMetadataInput) => void;
}

function MetadataEditor(props: MetadataEditorProps) {
  const [tagDraft, setTagDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState(props.metadata.note);

  useEffect(() => {
    setTagDraft("");
    setNoteDraft(props.metadata.note);
  }, [props.guest.id, props.metadata.note]);

  function addTag(tag: string) {
    const trimmedTag = tag.trim();
    if (!trimmedTag || props.metadata.tags.includes(trimmedTag)) {
      return;
    }

    props.onUpdate({ guestId: props.guest.id, tags: [...props.metadata.tags, trimmedTag] });
    setTagDraft("");
  }

  function removeTag(tag: string) {
    props.onUpdate({ guestId: props.guest.id, tags: props.metadata.tags.filter((candidate) => candidate !== tag) });
  }

  function saveNote() {
    if (noteDraft.trim() !== props.metadata.note) {
      props.onUpdate({ guestId: props.guest.id, note: noteDraft });
    }
  }

  return (
    <div className="metadata-editor">
      <div className="tag-stack">
        {props.metadata.tags.length === 0 ? <small>No tags yet.</small> : null}
        {props.metadata.tags.map((tag) => (
          <button type="button" key={tag} className="tag-chip removable" onClick={() => removeTag(tag)}>
            {tag} x
          </button>
        ))}
      </div>
      <div className="tag-presets">
        {props.tagOptions.filter((tag) => !props.metadata.tags.includes(tag)).slice(0, 8).map((tag) => (
          <button type="button" key={tag} onClick={() => addTag(tag)}>{tag}</button>
        ))}
      </div>
      <div className="metadata-row">
        <input
          value={tagDraft}
          onChange={(event) => setTagDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addTag(tagDraft);
            }
          }}
          placeholder="Custom tag"
        />
        <button type="button" onClick={() => addTag(tagDraft)}>Add</button>
      </div>
      <textarea
        value={noteDraft}
        onChange={(event) => setNoteDraft(event.target.value)}
        onBlur={saveNote}
        placeholder="Private seating note. Hidden from print unless enabled."
        rows={3}
      />
    </div>
  );
}

interface GuestListProps {
  snapshot: AppSnapshot;
  guestsById: Map<string, Guest>;
  assignments: Map<string, GuestAssignment>;
  seatedGuestIds: Set<string>;
  ignoredGuestIds: Set<string>;
  metadataByGuestId: Record<string, GuestMetadata>;
  selectedGuestIds: Set<string>;
  selectedTable: SeatingTable | null;
  filter: GuestFilter;
  search: string;
  selectedGuestId: string | null;
  onSelectGuest: (guestId: string) => void;
  onClearGuest: (guestId: string) => void;
  onSetGuestIgnored: (guestId: string, ignored: boolean) => void;
  onToggleGuestSelection: (guestId: string) => void;
  onSelectGuestIds: (guestIds: string[]) => void;
  onSeatParty: (partyId: string) => void;
}

function GuestList(props: GuestListProps) {
  const query = props.search.trim().toLowerCase();
  const visibleParties = props.snapshot.parties
    .map((party) => {
      const guests = party.guestIds
        .map((guestId) => props.guestsById.get(guestId))
        .filter(isGuest)
        .filter((guest) => guestMatchesFilters(guest, party, props, query));

      return { party, guests };
    })
    .filter(({ guests }) => guests.length > 0);
  const visibleGuestIds = visibleParties.flatMap(({ guests }) => guests.map((guest) => guest.id));

  if (visibleParties.length === 0) {
    return <p className="empty-list">No guests match this filter.</p>;
  }

  return (
    <div className="guest-list">
      <button type="button" className="ghost-button select-visible-button" onClick={() => props.onSelectGuestIds(visibleGuestIds)}>
        Select visible ({visibleGuestIds.length})
      </button>
      {visibleParties.map(({ party, guests }) => (
        <PartyCard key={party.id} party={party} guests={guests} {...props} />
      ))}
    </div>
  );
}

function PartyCard(props: GuestListProps & { party: GuestParty; guests: Guest[] }) {
  const activePartyGuestIds = props.party.guestIds.filter((guestId) => !props.ignoredGuestIds.has(guestId));
  const seatedCount = activePartyGuestIds.filter((guestId) => props.assignments.has(guestId)).length;
  const ignoredCount = props.party.guestIds.length - activePartyGuestIds.length;
  const availableSeats = props.selectedTable ? openSeatsForParty(props.selectedTable, new Set(activePartyGuestIds)) : 0;
  const canSeatParty = Boolean(props.selectedTable) && activePartyGuestIds.length > 0 && availableSeats >= activePartyGuestIds.length;

  return (
    <section className="party-card">
      <div className="party-heading">
        <div>
          <strong>{props.party.label}</strong>
          <small>{activePartyGuestIds.length} active, {seatedCount} seated, {ignoredCount} ignored</small>
        </div>
        <span>{props.party.relationship}</span>
      </div>
      {props.selectedTable ? (
        <button type="button" className="party-seat-button" disabled={!canSeatParty} onClick={() => props.onSeatParty(props.party.id)}>
          Seat party at {props.selectedTable.name}
        </button>
      ) : null}
      <div className="guest-stack">
        {props.guests.map((guest) => {
          const assignment = props.assignments.get(guest.id);
          const isSelected = props.selectedGuestId === guest.id;
          const isIgnored = props.ignoredGuestIds.has(guest.id);
          const metadata = props.metadataByGuestId[guest.id] ?? EMPTY_METADATA;
          return (
            <div key={guest.id} className={`guest-row ${isSelected ? "selected" : ""} ${isIgnored ? "ignored" : ""}`}>
              <input
                type="checkbox"
                checked={props.selectedGuestIds.has(guest.id)}
                onChange={() => props.onToggleGuestSelection(guest.id)}
                aria-label={`Select ${guest.displayName}`}
              />
              <button type="button" onClick={() => props.onSelectGuest(guest.id)}>
                <span>{guest.displayName}</span>
                <small>{guest.kind}{guestStatusText(isIgnored, assignment)}</small>
                {metadata.tags.length > 0 ? (
                  <span className="guest-tags">{metadata.tags.slice(0, 3).join(", ")}</span>
                ) : null}
              </button>
              {isIgnored ? (
                <button type="button" className="mini-button" onClick={() => props.onSetGuestIgnored(guest.id, false)}>
                  Include
                </button>
              ) : assignment ? (
                <button type="button" className="mini-button" onClick={() => props.onClearGuest(guest.id)}>
                  Unseat
                </button>
              ) : (
                <button type="button" className="mini-button" onClick={() => props.onSetGuestIgnored(guest.id, true)}>
                  Ignore
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface TableCardProps {
  table: SeatingTable;
  position: { x: number; y: number };
  guestsById: Map<string, Guest>;
  selectedGuestId: string | null;
  selectedTableId: string | null;
  onSelectTable: (tableId: string) => void;
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
      className={`table-card ${props.table.shape} ${props.selectedTableId === props.table.id ? "selected-table" : ""}`}
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
        <button type="button" className="ghost-button" onClick={() => props.onSelectTable(props.table.id)}>
          Use for parties
        </button>
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

interface PrintViewProps {
  snapshot: AppSnapshot;
  guestsById: Map<string, Guest>;
  partiesById: Map<string, GuestParty>;
  assignments: Map<string, GuestAssignment>;
  ignoredGuestIds: Set<string>;
  metadataByGuestId: Record<string, GuestMetadata>;
  options: PrintOptions;
  onChangeOptions: (options: PrintOptions) => void;
  onBack: () => void;
}

function PrintView(props: PrintViewProps) {
  const seatedGuestIds = new Set(props.assignments.keys());
  const unseatedGuests = props.snapshot.guests.filter((guest) => !props.ignoredGuestIds.has(guest.id) && !seatedGuestIds.has(guest.id));
  const ignoredGuests = props.snapshot.guests.filter((guest) => props.ignoredGuestIds.has(guest.id));

  return (
    <main className={`print-shell ${props.options.compact ? "compact" : ""}`}>
      <section className="print-controls">
        <button type="button" className="ghost-button" onClick={props.onBack}>Back to editor</button>
        <button type="button" className="primary-button" onClick={() => window.print()}>Print / save PDF</button>
        <label>
          <input
            type="checkbox"
            checked={props.options.includeUnseated}
            onChange={(event) => props.onChangeOptions({ ...props.options, includeUnseated: event.target.checked })}
          />
          Include unseated
        </label>
        <label>
          <input
            type="checkbox"
            checked={props.options.includeIgnored}
            onChange={(event) => props.onChangeOptions({ ...props.options, includeIgnored: event.target.checked })}
          />
          Include ignored
        </label>
        <label>
          <input
            type="checkbox"
            checked={props.options.includeNotes}
            onChange={(event) => props.onChangeOptions({ ...props.options, includeNotes: event.target.checked })}
          />
          Include notes
        </label>
        <label>
          <input
            type="checkbox"
            checked={props.options.compact}
            onChange={(event) => props.onChangeOptions({ ...props.options, compact: event.target.checked })}
          />
          Compact
        </label>
      </section>

      <section className="print-header">
        <p className="eyebrow">Printable export</p>
        <h1>Wedding Seating Chart</h1>
        <p>Generated {new Date().toLocaleString()}</p>
      </section>

      <section className="print-tables">
        {props.snapshot.chart.tables.map((table) => (
          <article key={table.id} className={`print-table ${table.shape}`}>
            <div>
              <h2>{table.name}</h2>
              <span>{table.shape}, {table.seatCount} seats</span>
            </div>
            <ol>
              {table.seats.map((seat) => {
                const guest = seat.guestId ? props.guestsById.get(seat.guestId) ?? null : null;
                const party = guest ? props.partiesById.get(guest.partyId) ?? null : null;
                const metadata = guest ? props.metadataByGuestId[guest.id] ?? EMPTY_METADATA : EMPTY_METADATA;
                return (
                  <li key={seat.index}>
                    <strong>Seat {seat.index + 1}: {guest?.displayName ?? "Open"}</strong>
                    {party ? <span>{party.label}</span> : null}
                    {metadata.tags.length > 0 ? <small>{metadata.tags.join(", ")}</small> : null}
                    {props.options.includeNotes && metadata.note ? <small>{metadata.note}</small> : null}
                  </li>
                );
              })}
            </ol>
          </article>
        ))}
      </section>

      {props.options.includeUnseated ? (
        <PrintGuestSection title="Unseated Active Guests" guests={unseatedGuests} metadataByGuestId={props.metadataByGuestId} includeNotes={props.options.includeNotes} />
      ) : null}
      {props.options.includeIgnored ? (
        <PrintGuestSection title="Ignored Guests" guests={ignoredGuests} metadataByGuestId={props.metadataByGuestId} includeNotes={props.options.includeNotes} />
      ) : null}
    </main>
  );
}

function PrintGuestSection(props: {
  title: string;
  guests: Guest[];
  metadataByGuestId: Record<string, GuestMetadata>;
  includeNotes: boolean;
}) {
  if (props.guests.length === 0) {
    return null;
  }

  return (
    <section className="print-guest-section">
      <h2>{props.title}</h2>
      <ul>
        {props.guests.map((guest) => {
          const metadata = props.metadataByGuestId[guest.id] ?? EMPTY_METADATA;
          return (
            <li key={guest.id}>
              <strong>{guest.displayName}</strong>
              {metadata.tags.length > 0 ? <span>{metadata.tags.join(", ")}</span> : null}
              {props.includeNotes && metadata.note ? <small>{metadata.note}</small> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function guestMatchesFilters(guest: Guest, party: GuestParty, props: GuestListProps, query: string): boolean {
  const isSeated = props.seatedGuestIds.has(guest.id);
  const isIgnored = props.ignoredGuestIds.has(guest.id);
  const metadata = props.metadataByGuestId[guest.id] ?? EMPTY_METADATA;

  if (props.filter === "unseated" && (isSeated || isIgnored)) {
    return false;
  }
  if (props.filter === "seated" && (!isSeated || isIgnored)) {
    return false;
  }
  if (props.filter === "ignored" && !isIgnored) {
    return false;
  }
  if (!query) {
    return true;
  }

  return `${guest.displayName} ${guest.fullName} ${party.label} ${party.relationship} ${metadata.tags.join(" ")} ${metadata.note} ${isIgnored ? "ignored" : ""}`
    .toLowerCase()
    .includes(query);
}

function guestStatusText(isIgnored: boolean, assignment: GuestAssignment | undefined): string {
  if (isIgnored) {
    return " - ignored";
  }

  if (assignment) {
    return ` - ${assignment.tableName}, seat ${assignment.seatIndex + 1}`;
  }

  return " - unseated";
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

function buildTagOptions(metadataByGuestId: Record<string, GuestMetadata>): string[] {
  const tags = Object.values(metadataByGuestId).flatMap((metadata) => metadata.tags);
  return [...new Set([...TAG_PRESETS, ...tags])].sort();
}

function openSeatsForParty(table: SeatingTable, partyGuestIds: Set<string>): number {
  return table.seats.filter((seat) => seat.guestId === null || partyGuestIds.has(seat.guestId)).length;
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
