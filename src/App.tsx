import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";

import type {
  AppSnapshot,
  BulkUpdateGuestsInput,
  ClearSeatInput,
  ClientToServerEvents,
  CreateFloorPlanObjectInput,
  DeleteFloorPlanObjectInput,
  FloorPlanObject,
  FloorPlanObjectKind,
  Guest,
  GuestMetadata,
  GuestParty,
  HistoryEntrySummary,
  MutationAck,
  SeatAssignment,
  SeatingTable,
  ServerToClientEvents,
  SetChartLockedInput,
  SetTableLockedInput,
  TableShape,
  UpdateFloorPlanObjectInput,
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
  type: "table" | "floor";
  id: string;
  startPointerX: number;
  startPointerY: number;
  startX: number;
  startY: number;
}

interface PanState {
  startPointerX: number;
  startPointerY: number;
  startScrollLeft: number;
  startScrollTop: number;
}

interface ResizeState {
  objectId: string;
  startPointerX: number;
  startPointerY: number;
  startWidth: number;
  startHeight: number;
}

interface PrintOptions {
  includeIgnored: boolean;
  includeUnseated: boolean;
  compact: boolean;
}

const ROUND_STAGE_SIZE = 320;
const RECT_STAGE_WIDTH = 380;
const RECT_STAGE_HEIGHT = 280;
const CANVAS_WIDTH = 5600;
const CANVAS_HEIGHT = 3600;
const MIN_CANVAS_ZOOM = 0.45;
const MAX_CANVAS_ZOOM = 1.6;
const TAG_PRESETS = ["vendor", "family", "wedding party", "do not seat near", "needs aisle", "child", "high priority"];
const EMPTY_METADATA: GuestMetadata = { tags: [], note: "" };
const FLOOR_OBJECT_KINDS: FloorPlanObjectKind[] = ["dance-floor", "bar", "dj", "head-table", "door", "wall", "label", "blocked-area"];

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
  const [newFloorObjectKind, setNewFloorObjectKind] = useState<FloorPlanObjectKind>("dance-floor");
  const [newFloorObjectLabel, setNewFloorObjectLabel] = useState("");
  const [bulkTag, setBulkTag] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntrySummary[]>([]);
  const [printMode, setPrintMode] = useState(false);
  const [printOptions, setPrintOptions] = useState<PrintOptions>({
    includeIgnored: false,
    includeUnseated: true,
    compact: false,
  });
  const [canvasZoom, setCanvasZoom] = useState(0.85);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [panState, setPanState] = useState<PanState | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [collapsedTableIds, setCollapsedTableIds] = useState<Set<string>>(new Set());
  const [collapsedFloorObjectIds, setCollapsedFloorObjectIds] = useState<Set<string>>(new Set());
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [localFloorObjectSizes, setLocalFloorObjectSizes] = useState<Record<string, { width: number; height: number }>>({});
  const localPositionsRef = useRef(localPositions);
  const localFloorObjectSizesRef = useRef(localFloorObjectSizes);
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    localPositionsRef.current = localPositions;
  }, [localPositions]);

  useEffect(() => {
    localFloorObjectSizesRef.current = localFloorObjectSizes;
  }, [localFloorObjectSizes]);

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
    const activeZoom = canvasZoom;

    function handlePointerMove(event: globalThis.PointerEvent) {
      const x = Math.max(0, activeDrag.startX + (event.clientX - activeDrag.startPointerX) / activeZoom);
      const y = Math.max(0, activeDrag.startY + (event.clientY - activeDrag.startPointerY) / activeZoom);
      setLocalPositions((current) => ({ ...current, [activeDrag.id]: { x, y } }));
    }

    function handlePointerUp() {
      const position = localPositionsRef.current[activeDrag.id] ?? { x: activeDrag.startX, y: activeDrag.startY };
      if (activeDrag.type === "table") {
        activeSocket.emit("table:update", { tableId: activeDrag.id, x: position.x, y: position.y }, handleAck);
      } else {
        activeSocket.emit("floor:update", { objectId: activeDrag.id, x: position.x, y: position.y }, handleAck);
      }
      setLocalPositions((current) => {
        const next = { ...current };
        delete next[activeDrag.id];
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
  }, [canvasZoom, dragState, socket]);

  useEffect(() => {
    if (!panState) {
      return;
    }

    const activePan = panState;

    function handlePointerMove(event: globalThis.PointerEvent) {
      const viewport = canvasViewportRef.current;
      if (!viewport) {
        return;
      }

      viewport.scrollLeft = activePan.startScrollLeft - (event.clientX - activePan.startPointerX);
      viewport.scrollTop = activePan.startScrollTop - (event.clientY - activePan.startPointerY);
    }

    function handlePointerUp() {
      setPanState(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [panState]);

  useEffect(() => {
    if (!resizeState || !socket) {
      return;
    }

    const activeResize = resizeState;
    const activeSocket = socket;
    const activeZoom = canvasZoom;

    function handlePointerMove(event: globalThis.PointerEvent) {
      const width = Math.max(24, activeResize.startWidth + (event.clientX - activeResize.startPointerX) / activeZoom);
      const height = Math.max(24, activeResize.startHeight + (event.clientY - activeResize.startPointerY) / activeZoom);
      setLocalFloorObjectSizes((current) => ({ ...current, [activeResize.objectId]: { width, height } }));
    }

    function handlePointerUp() {
      const size = localFloorObjectSizesRef.current[activeResize.objectId] ?? {
        width: activeResize.startWidth,
        height: activeResize.startHeight,
      };
      activeSocket.emit("floor:update", { objectId: activeResize.objectId, width: size.width, height: size.height }, handleAck);
      setLocalFloorObjectSizes((current) => {
        const next = { ...current };
        delete next[activeResize.objectId];
        return next;
      });
      setResizeState(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [canvasZoom, resizeState, socket]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    void loadHistory();
  }, [snapshot?.chart.updatedAt]);

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
  const capacity = snapshot ? buildCapacitySummary(snapshot, ignoredGuestIds, seatedGuestIds) : null;
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

  function setChartLocked(input: SetChartLockedInput) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("chart:lock", input, handleAck);
  }

  function setTableLocked(input: SetTableLockedInput) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("table:lock", input, handleAck);
  }

  function createFloorPlanObject(input: CreateFloorPlanObjectInput) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("floor:create", input, handleAck);
  }

  function updateFloorPlanObject(input: UpdateFloorPlanObjectInput) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("floor:update", input, handleAck);
  }

  function deleteFloorPlanObject(input: DeleteFloorPlanObjectInput) {
    if (!socket) {
      setNotice("Not connected to the seating chart server");
      return;
    }

    socket.emit("floor:delete", input, handleAck);
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
      type: "table",
      id: table.id,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: localPositions[table.id]?.x ?? table.x,
      startY: localPositions[table.id]?.y ?? table.y,
    });
  }

  function startFloorObjectDrag(object: FloorPlanObject, event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    setDragState({
      type: "floor",
      id: object.id,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: localPositions[object.id]?.x ?? object.x,
      startY: localPositions[object.id]?.y ?? object.y,
    });
  }

  function startFloorObjectResize(object: FloorPlanObject, event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setResizeState({
      objectId: object.id,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startWidth: localFloorObjectSizes[object.id]?.width ?? object.width,
      startHeight: localFloorObjectSizes[object.id]?.height ?? object.height,
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

  function undoLastAction() {
    const previousEntry = historyEntries[1];
    if (!previousEntry) {
      setNotice("There is no previous snapshot to restore");
      return;
    }

    restoreHistory(previousEntry.id);
  }

  function downloadCsvExport() {
    if (!snapshot) {
      return;
    }

    downloadCsv("seating-chart-assignments.csv", buildCsvExport(snapshot, guestsById, partiesById, ignoredGuestIds, metadataByGuestId));
  }

  function startCanvasPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.target !== event.currentTarget) {
      return;
    }
    const viewport = canvasViewportRef.current;
    if (!viewport) {
      return;
    }

    event.preventDefault();
    setPanState({
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startScrollLeft: viewport.scrollLeft,
      startScrollTop: viewport.scrollTop,
    });
  }

  function setClampedCanvasZoom(nextZoom: number) {
    setCanvasZoom(Math.min(Math.max(nextZoom, MIN_CANVAS_ZOOM), MAX_CANVAS_ZOOM));
  }

  function resetCanvasView() {
    setCanvasZoom(0.85);
    requestAnimationFrame(() => {
      const viewport = canvasViewportRef.current;
      if (!viewport) {
        return;
      }

      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    });
  }

  function toggleTableCollapsed(tableId: string) {
    setCollapsedTableIds((current) => {
      const next = new Set(current);
      if (next.has(tableId)) {
        next.delete(tableId);
      } else {
        next.add(tableId);
      }
      return next;
    });
  }

  function toggleFloorObjectCollapsed(objectId: string) {
    setCollapsedFloorObjectIds((current) => {
      const next = new Set(current);
      if (next.has(objectId)) {
        next.delete(objectId);
      } else {
        next.add(objectId);
      }
      return next;
    });
  }

  function centerUsedCanvasArea() {
    if (!snapshot) {
      return;
    }

    const viewport = canvasViewportRef.current;
    if (!viewport) {
      return;
    }

    const positions = [
      ...snapshot.chart.tables.map((table) => ({ x: table.x, y: table.y })),
      ...snapshot.chart.floorPlanObjects.map((object) => ({ x: object.x, y: object.y })),
    ];
    if (positions.length === 0) {
      resetCanvasView();
      return;
    }

    const minX = Math.max(0, Math.min(...positions.map((position) => position.x)) - 160);
    const minY = Math.max(0, Math.min(...positions.map((position) => position.y)) - 160);
    viewport.scrollLeft = minX * canvasZoom;
    viewport.scrollTop = minY * canvasZoom;
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
          {snapshot.chart.locked ? <span className="status-pill offline">chart locked</span> : null}
          <button type="button" className="ghost-button" onClick={() => setPrintMode(true)}>Print / export</button>
          <button type="button" className="ghost-button" onClick={downloadCsvExport}>CSV export</button>
          <button type="button" className="ghost-button" onClick={() => setChartLocked({ locked: !snapshot.chart.locked })}>
            {snapshot.chart.locked ? "Unlock chart" : "Lock chart"}
          </button>
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

      <section className="dashboard-grid">
        {capacity ? <CapacityDashboard summary={capacity} /> : null}
        <RecentActivity entries={historyEntries.slice(0, 5)} onUndo={undoLastAction} canUndo={historyEntries.length > 1} />
      </section>

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
              <small className="canvas-hint">Drag empty grid space to pan. Use table handles to move objects.</small>
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
              <button type="button" className="primary-button" disabled={snapshot.chart.locked} onClick={createNewTable}>Add table</button>
              <label>
                Floor item
                <select value={newFloorObjectKind} onChange={(event) => setNewFloorObjectKind(event.target.value as FloorPlanObjectKind)}>
                  {FLOOR_OBJECT_KINDS.map((kind) => <option key={kind} value={kind}>{formatFloorObjectKind(kind)}</option>)}
                </select>
              </label>
              <label>
                Label
                <input value={newFloorObjectLabel} onChange={(event) => setNewFloorObjectLabel(event.target.value)} placeholder="Optional" />
              </label>
              <button
                type="button"
                className="primary-button floor-button"
                disabled={snapshot.chart.locked}
                onClick={() => {
                  createFloorPlanObject({ kind: newFloorObjectKind, label: newFloorObjectLabel });
                  setNewFloorObjectLabel("");
                }}
              >
                Add floor item
              </button>
            </div>
          </div>

          <div className="canvas-controls" aria-label="canvas controls">
            <button type="button" onClick={() => setClampedCanvasZoom(canvasZoom - 0.1)}>Zoom out</button>
            <span>{Math.round(canvasZoom * 100)}%</span>
            <button type="button" onClick={() => setClampedCanvasZoom(canvasZoom + 0.1)}>Zoom in</button>
            <button type="button" onClick={centerUsedCanvasArea}>Center used area</button>
            <button type="button" onClick={resetCanvasView}>Reset view</button>
            <span>{CANVAS_WIDTH.toLocaleString()} x {CANVAS_HEIGHT.toLocaleString()} workspace</span>
          </div>

          <div ref={canvasViewportRef} className={`canvas-viewport ${panState ? "panning" : ""}`}>
            <div
              className="canvas-zoom-frame"
              style={{ width: CANVAS_WIDTH * canvasZoom, height: CANVAS_HEIGHT * canvasZoom }}
            >
              <div
                className="canvas"
                style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `scale(${canvasZoom})` }}
                onPointerDown={startCanvasPan}
              >
                {snapshot.chart.tables.length === 0 ? (
                  <div className="empty-canvas">
                    <p className="eyebrow">Start here</p>
                    <h2>Add a round or rectangle table.</h2>
                    <p>Select guests from the left, then click empty seats to place them. Drag empty grid space to pan around the larger workspace.</p>
                  </div>
                ) : null}

                {snapshot.chart.floorPlanObjects.map((object) => (
                  <FloorObjectCard
                    key={object.id}
                    object={object}
                    position={localPositions[object.id] ?? { x: object.x, y: object.y }}
                    size={localFloorObjectSizes[object.id] ?? { width: object.width, height: object.height }}
                    chartLocked={snapshot.chart.locked}
                    collapsed={collapsedFloorObjectIds.has(object.id)}
                    onToggleCollapsed={toggleFloorObjectCollapsed}
                    onStartDrag={startFloorObjectDrag}
                    onStartResize={startFloorObjectResize}
                    onUpdate={updateFloorPlanObject}
                    onDelete={deleteFloorPlanObject}
                  />
                ))}

                {snapshot.chart.tables.map((table) => (
                  <TableCard
                    key={table.id}
                    table={table}
                    position={localPositions[table.id] ?? { x: table.x, y: table.y }}
                    guestsById={guestsById}
                    selectedGuestId={selectedGuestId}
                    selectedTableId={selectedTableId}
                    chartLocked={snapshot.chart.locked}
                    collapsed={collapsedTableIds.has(table.id)}
                    onSelectTable={setSelectedTableId}
                    onToggleCollapsed={toggleTableCollapsed}
                    onStartDrag={startTableDrag}
                    onUpdateTable={updateTable}
                    onDeleteTable={deleteTable}
                    onSetTableLocked={setTableLocked}
                    onSeatClick={assignSeat}
                    onClearSeat={clearSeat}
                    onLocalError={setNotice}
                  />
                ))}
              </div>
            </div>
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

interface CapacitySummary {
  totalSeats: number;
  activeGuests: number;
  seatedGuests: number;
  ignoredGuests: number;
  unseatedGuests: number;
  openSeats: number;
  surplusSeats: number;
}

function CapacityDashboard(props: { summary: CapacitySummary }) {
  const status = props.summary.surplusSeats >= 0 ? "surplus" : "short";
  return (
    <section className={`capacity-dashboard ${status}`}>
      <div>
        <p className="eyebrow">Capacity</p>
        <h2>{props.summary.surplusSeats >= 0 ? `${props.summary.surplusSeats} extra seats` : `${Math.abs(props.summary.surplusSeats)} seats short`}</h2>
      </div>
      <dl>
        <div><dt>Total seats</dt><dd>{props.summary.totalSeats}</dd></div>
        <div><dt>Active guests</dt><dd>{props.summary.activeGuests}</dd></div>
        <div><dt>Seated</dt><dd>{props.summary.seatedGuests}</dd></div>
        <div><dt>Unseated</dt><dd>{props.summary.unseatedGuests}</dd></div>
        <div><dt>Open seats</dt><dd>{props.summary.openSeats}</dd></div>
        <div><dt>Ignored</dt><dd>{props.summary.ignoredGuests}</dd></div>
      </dl>
    </section>
  );
}

function RecentActivity(props: { entries: HistoryEntrySummary[]; canUndo: boolean; onUndo: () => void }) {
  return (
    <section className="recent-activity">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Recent activity</p>
          <h2>{props.entries.length === 0 ? "No edits yet" : props.entries[0]?.action}</h2>
        </div>
        <button type="button" className="ghost-button" disabled={!props.canUndo} onClick={props.onUndo}>Undo last</button>
      </div>
      {props.entries.length === 0 ? (
        <p className="empty-list">Recent edits will appear here.</p>
      ) : (
        <ul>
          {props.entries.slice(0, 4).map((entry) => (
            <li key={entry.id}>
              <strong>{entry.action}</strong>
              <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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
  chartLocked: boolean;
  collapsed: boolean;
  onSelectTable: (tableId: string) => void;
  onToggleCollapsed: (tableId: string) => void;
  onStartDrag: (table: SeatingTable, event: PointerEvent<HTMLButtonElement>) => void;
  onUpdateTable: (input: UpdateTableInput) => void;
  onDeleteTable: (tableId: string) => void;
  onSetTableLocked: (input: SetTableLockedInput) => void;
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
      className={`table-card ${props.table.shape} ${props.selectedTableId === props.table.id ? "selected-table" : ""} ${props.table.locked ? "locked" : ""} ${props.collapsed ? "collapsed" : ""}`}
      style={{ left: props.position.x, top: props.position.y }}
    >
      {props.collapsed ? (
        <>
          <button
            type="button"
            className="drag-handle compact"
            disabled={props.chartLocked || props.table.locked}
            onPointerDown={(event) => props.onStartDrag(props.table, event)}
            aria-label={`Move ${props.table.name}`}
          >
            Move
          </button>
          <button
            type="button"
            className="table-edit-toggle compact"
            onClick={() => props.onToggleCollapsed(props.table.id)}
            aria-label={`Expand editing controls for ${props.table.name}`}
          >
            Edit
          </button>
        </>
      ) : (
        <>
          <div className="table-card-header">
            <button type="button" className="drag-handle" disabled={props.chartLocked || props.table.locked} onPointerDown={(event) => props.onStartDrag(props.table, event)}>
              Drag
            </button>
            <input
              className="table-name-input"
              value={draftName}
              disabled={props.chartLocked || props.table.locked}
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
              disabled={props.chartLocked || props.table.locked || occupiedCount > 0}
              title={occupiedCount > 0 ? "Unseat guests before deleting this table" : "Delete table"}
              onClick={() => props.onDeleteTable(props.table.id)}
            >
              Delete
            </button>
            <button type="button" className="table-edit-toggle" onClick={() => props.onToggleCollapsed(props.table.id)}>
              Collapse
            </button>
          </div>

          <div className="table-settings">
            <label>
              Shape
              <select
                value={props.table.shape}
                disabled={props.chartLocked || props.table.locked}
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
                disabled={props.chartLocked || props.table.locked}
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
            <button type="button" className="ghost-button" disabled={props.chartLocked} onClick={() => props.onSetTableLocked({ tableId: props.table.id, locked: !props.table.locked })}>
              {props.table.locked ? "Unlock table" : "Lock table"}
            </button>
          </div>
        </>
      )}

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
              disabled={props.chartLocked || props.table.locked}
              onSeatClick={props.onSeatClick}
              onClearSeat={props.onClearSeat}
            />
          );
        })}
      </div>
    </article>
  );
}

interface FloorObjectCardProps {
  object: FloorPlanObject;
  position: { x: number; y: number };
  size: { width: number; height: number };
  chartLocked: boolean;
  collapsed: boolean;
  onToggleCollapsed: (objectId: string) => void;
  onStartDrag: (object: FloorPlanObject, event: PointerEvent<HTMLButtonElement>) => void;
  onStartResize: (object: FloorPlanObject, event: PointerEvent<HTMLButtonElement>) => void;
  onUpdate: (input: UpdateFloorPlanObjectInput) => void;
  onDelete: (input: DeleteFloorPlanObjectInput) => void;
}

function FloorObjectCard(props: FloorObjectCardProps) {
  const [labelDraft, setLabelDraft] = useState(props.object.label);
  const [widthDraft, setWidthDraft] = useState(String(props.object.width));
  const [heightDraft, setHeightDraft] = useState(String(props.object.height));

  useEffect(() => {
    setLabelDraft(props.object.label);
  }, [props.object.label]);

  useEffect(() => {
    setWidthDraft(String(props.object.width));
    setHeightDraft(String(props.object.height));
  }, [props.object.width, props.object.height]);

  function commitLabel() {
    if (labelDraft.trim() !== props.object.label) {
      props.onUpdate({ objectId: props.object.id, label: labelDraft });
    }
  }

  function commitSize() {
    const width = Number(widthDraft);
    const height = Number(heightDraft);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      props.onUpdate({ objectId: props.object.id, width, height });
      return;
    }

    setWidthDraft(String(props.object.width));
    setHeightDraft(String(props.object.height));
  }

  return (
    <article
      className={`floor-object ${props.object.kind} ${props.collapsed ? "collapsed" : ""}`}
      style={{ left: props.position.x, top: props.position.y, width: props.size.width, height: props.size.height }}
    >
      {props.collapsed ? (
        <>
          <button
            type="button"
            className="drag-handle compact"
            disabled={props.chartLocked}
            onPointerDown={(event) => props.onStartDrag(props.object, event)}
            aria-label={`Move ${props.object.label}`}
          >
            Move
          </button>
          <button
            type="button"
            className="table-edit-toggle compact"
            onClick={() => props.onToggleCollapsed(props.object.id)}
            aria-label={`Expand editing controls for ${props.object.label}`}
          >
            Edit
          </button>
          <div className="floor-object-label compact-label">
            <strong>{props.object.label}</strong>
            <span>{formatFloorObjectKind(props.object.kind)}</span>
          </div>
        </>
      ) : (
        <>
          <div className="floor-object-header">
            <button type="button" className="drag-handle" disabled={props.chartLocked} onPointerDown={(event) => props.onStartDrag(props.object, event)}>
              Drag
            </button>
            <select
              value={props.object.kind}
              disabled={props.chartLocked}
              onChange={(event) => props.onUpdate({ objectId: props.object.id, kind: event.target.value as FloorPlanObjectKind })}
            >
              {FLOOR_OBJECT_KINDS.map((kind) => <option key={kind} value={kind}>{formatFloorObjectKind(kind)}</option>)}
            </select>
            <button type="button" className="danger-button" disabled={props.chartLocked} onClick={() => props.onDelete({ objectId: props.object.id })}>Delete</button>
            <button type="button" className="table-edit-toggle" onClick={() => props.onToggleCollapsed(props.object.id)}>Collapse</button>
          </div>
          <input
            className="floor-label-input"
            value={labelDraft}
            disabled={props.chartLocked}
            onChange={(event) => setLabelDraft(event.target.value)}
            onBlur={commitLabel}
            aria-label="floor plan object label"
          />
          <div className="floor-size-row">
            <input value={widthDraft} disabled={props.chartLocked} onChange={(event) => setWidthDraft(event.target.value)} onBlur={commitSize} aria-label="floor object width" />
            <input value={heightDraft} disabled={props.chartLocked} onChange={(event) => setHeightDraft(event.target.value)} onBlur={commitSize} aria-label="floor object height" />
          </div>
        </>
      )}
      <button
        type="button"
        className="floor-resize-handle"
        disabled={props.chartLocked}
        onPointerDown={(event) => props.onStartResize(props.object, event)}
        aria-label={`Resize ${props.object.label}`}
      />
    </article>
  );
}

interface SeatButtonProps {
  table: SeatingTable;
  seat: SeatAssignment;
  guest: Guest | null;
  selectedGuestId: string | null;
  disabled: boolean;
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
        disabled={props.disabled}
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
          disabled={props.disabled}
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

      {props.snapshot.chart.floorPlanObjects.length > 0 ? (
        <section className="print-floor-objects">
          <h2>Floor Plan Details</h2>
          <ul>
            {props.snapshot.chart.floorPlanObjects.map((object) => (
              <li key={object.id}>{object.label} ({formatFloorObjectKind(object.kind)})</li>
            ))}
          </ul>
        </section>
      ) : null}

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
                  </li>
                );
              })}
            </ol>
          </article>
        ))}
      </section>

      {props.options.includeUnseated ? (
        <PrintGuestSection title="Unseated Active Guests" guests={unseatedGuests} metadataByGuestId={props.metadataByGuestId} />
      ) : null}
      {props.options.includeIgnored ? (
        <PrintGuestSection title="Ignored Guests" guests={ignoredGuests} metadataByGuestId={props.metadataByGuestId} />
      ) : null}
    </main>
  );
}

function PrintGuestSection(props: {
  title: string;
  guests: Guest[];
  metadataByGuestId: Record<string, GuestMetadata>;
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

function buildCapacitySummary(snapshot: AppSnapshot, ignoredGuestIds: Set<string>, seatedGuestIds: Set<string>): CapacitySummary {
  const totalSeats = snapshot.chart.tables.reduce((total, table) => total + table.seatCount, 0);
  const activeGuests = snapshot.guests.length - ignoredGuestIds.size;
  const seatedGuests = [...seatedGuestIds].filter((guestId) => !ignoredGuestIds.has(guestId)).length;
  const unseatedGuests = activeGuests - seatedGuests;
  const openSeats = snapshot.chart.tables.reduce((total, table) => total + table.seats.filter((seat) => seat.guestId === null).length, 0);

  return {
    totalSeats,
    activeGuests,
    seatedGuests,
    ignoredGuests: ignoredGuestIds.size,
    unseatedGuests,
    openSeats,
    surplusSeats: totalSeats - activeGuests,
  };
}

function buildCsvExport(
  snapshot: AppSnapshot,
  guestsById: Map<string, Guest>,
  partiesById: Map<string, GuestParty>,
  ignoredGuestIds: Set<string>,
  metadataByGuestId: Record<string, GuestMetadata>,
): string {
  const rows = [["Status", "Table", "Seat", "Guest", "Party", "Relationship", "Tags"]];
  const assignedGuestIds = new Set<string>();

  snapshot.chart.tables.forEach((table) => {
    table.seats.forEach((seat) => {
      const guest = seat.guestId ? guestsById.get(seat.guestId) ?? null : null;
      if (guest) {
        assignedGuestIds.add(guest.id);
      }
      const party = guest ? partiesById.get(guest.partyId) ?? null : null;
      const metadata = guest ? metadataByGuestId[guest.id] ?? EMPTY_METADATA : EMPTY_METADATA;
      rows.push([
        guest ? "Seated" : "Open",
        table.name,
        String(seat.index + 1),
        guest?.displayName ?? "",
        party?.label ?? "",
        party?.relationship ?? "",
        metadata.tags.join("; "),
      ]);
    });
  });

  snapshot.guests.forEach((guest) => {
    if (assignedGuestIds.has(guest.id)) {
      return;
    }

    const party = partiesById.get(guest.partyId) ?? null;
    const metadata = metadataByGuestId[guest.id] ?? EMPTY_METADATA;
    rows.push([
      ignoredGuestIds.has(guest.id) ? "Ignored" : "Unseated",
      "",
      "",
      guest.displayName,
      party?.label ?? "",
      party?.relationship ?? "",
      metadata.tags.join("; "),
    ]);
  });

  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string): string {
  if (/[,"\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatFloorObjectKind(kind: FloorPlanObjectKind): string {
  return kind.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
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
