import { describe, expect, it } from "vitest";

import {
  assignSeat,
  bulkUpdateGuests,
  createEmptyChart,
  createTable,
  seatPartyAtTable,
  setGuestIgnored,
  updateGuestMetadata,
  updateTable,
} from "../server/state";

describe("seating chart state", () => {
  it("blocks reducing a table below an occupied removed seat", () => {
    const validGuestIds = new Set(["guest-1"]);
    let chart = createTable(createEmptyChart(), { shape: "round", seatCount: 4 });
    const table = chart.tables[0];
    expect(table).toBeDefined();

    chart = assignSeat(chart, { tableId: table!.id, seatIndex: 3, guestId: "guest-1" }, validGuestIds);

    expect(() => updateTable(chart, { tableId: table!.id, seatCount: 3 })).toThrow(/removed seats is occupied/i);
  });

  it("prevents the same guest from being assigned twice", () => {
    const validGuestIds = new Set(["guest-1"]);
    let chart = createTable(createEmptyChart(), { shape: "rectangle", seatCount: 6 });
    const table = chart.tables[0];
    expect(table).toBeDefined();

    chart = assignSeat(chart, { tableId: table!.id, seatIndex: 0, guestId: "guest-1" }, validGuestIds);

    expect(() => assignSeat(chart, { tableId: table!.id, seatIndex: 1, guestId: "guest-1" }, validGuestIds)).toThrow(/already seated/i);
  });

  it("unseats a guest when they are ignored", () => {
    const validGuestIds = new Set(["guest-1"]);
    let chart = createTable(createEmptyChart(), { shape: "round", seatCount: 4 });
    const table = chart.tables[0];
    expect(table).toBeDefined();

    chart = assignSeat(chart, { tableId: table!.id, seatIndex: 0, guestId: "guest-1" }, validGuestIds);
    chart = setGuestIgnored(chart, { guestId: "guest-1", ignored: true }, validGuestIds);

    expect(chart.ignoredGuestIds).toEqual(["guest-1"]);
    expect(chart.tables[0]?.seats[0]?.guestId).toBeNull();
  });

  it("prevents ignored guests from being assigned", () => {
    const validGuestIds = new Set(["guest-1"]);
    let chart = createTable(createEmptyChart(), { shape: "rectangle", seatCount: 6 });
    const table = chart.tables[0];
    expect(table).toBeDefined();

    chart = setGuestIgnored(chart, { guestId: "guest-1", ignored: true }, validGuestIds);

    expect(() => assignSeat(chart, { tableId: table!.id, seatIndex: 0, guestId: "guest-1" }, validGuestIds)).toThrow(/ignored/i);
  });

  it("updates guest tags and notes", () => {
    const validGuestIds = new Set(["guest-1"]);
    const chart = updateGuestMetadata(
      createEmptyChart(),
      { guestId: "guest-1", tags: ["vendor", "needs aisle", "vendor"], note: "Seat near exit" },
      validGuestIds,
    );

    expect(chart.guestMetadata["guest-1"]).toEqual({
      tags: ["needs aisle", "vendor"],
      note: "Seat near exit",
    });
  });

  it("bulk ignores guests and unseats selected guests", () => {
    const validGuestIds = new Set(["guest-1", "guest-2"]);
    let chart = createTable(createEmptyChart(), { shape: "round", seatCount: 4 });
    const table = chart.tables[0];
    expect(table).toBeDefined();

    chart = assignSeat(chart, { tableId: table!.id, seatIndex: 0, guestId: "guest-1" }, validGuestIds);
    chart = bulkUpdateGuests(chart, { guestIds: ["guest-1", "guest-2"], ignored: true, addTag: "vendor" }, validGuestIds);

    expect(chart.ignoredGuestIds).toEqual(["guest-1", "guest-2"]);
    expect(chart.tables[0]?.seats[0]?.guestId).toBeNull();
    expect(chart.guestMetadata["guest-1"]?.tags).toEqual(["vendor"]);
  });

  it("moves split party members to one table", () => {
    const validGuestIds = new Set(["guest-1", "guest-2", "guest-3"]);
    let chart = createTable(createEmptyChart(), { shape: "round", seatCount: 3 });
    chart = createTable(chart, { shape: "rectangle", seatCount: 3 });
    const firstTable = chart.tables[0];
    const secondTable = chart.tables[1];
    expect(firstTable).toBeDefined();
    expect(secondTable).toBeDefined();

    chart = assignSeat(chart, { tableId: firstTable!.id, seatIndex: 0, guestId: "guest-1" }, validGuestIds);
    chart = assignSeat(chart, { tableId: secondTable!.id, seatIndex: 0, guestId: "guest-2" }, validGuestIds);
    chart = seatPartyAtTable(chart, { partyId: "party-1", tableId: firstTable!.id }, ["guest-1", "guest-2", "guest-3"]);

    const seatedAtFirstTable = chart.tables[0]?.seats.map((seat) => seat.guestId).filter(Boolean);
    expect(seatedAtFirstTable).toEqual(["guest-1", "guest-2", "guest-3"]);
    expect(chart.tables[1]?.seats[0]?.guestId).toBeNull();
  });

  it("rejects party seating when the destination table lacks capacity", () => {
    let chart = createTable(createEmptyChart(), { shape: "round", seatCount: 2 });
    const table = chart.tables[0];
    expect(table).toBeDefined();

    expect(() => seatPartyAtTable(chart, { partyId: "party-1", tableId: table!.id }, ["guest-1", "guest-2", "guest-3"])).toThrow(/not enough open seats/i);
  });
});
