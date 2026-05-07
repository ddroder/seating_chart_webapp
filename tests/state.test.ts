import { describe, expect, it } from "vitest";

import { assignSeat, createEmptyChart, createTable, updateTable } from "../server/state";

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
});
