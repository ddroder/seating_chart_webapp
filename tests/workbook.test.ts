import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadGuestData } from "../server/workbook";

describe("loadGuestData", () => {
  it("parses guests and parties from the exported workbook", async () => {
    const data = await loadGuestData(resolve("export.xlsx"));

    expect(data.parties).toHaveLength(133);
    expect(data.guests).toHaveLength(274);
    expect(data.guests[0]).toMatchObject({
      id: "guest-2-primary",
      partyId: "party-2",
      displayName: "Elizabeth Abend",
      kind: "primary",
    });
  });

  it("does not expose contact or address fields", async () => {
    const data = await loadGuestData(resolve("export.xlsx"));
    const keys = Object.keys(data.guests[0] ?? {}).sort();

    expect(keys).toEqual(["displayName", "fullName", "id", "kind", "partyId", "relationship"]);
  });
});
