import { existsSync } from "node:fs";

import ExcelJS from "exceljs";

import type { Guest, GuestKind, GuestParty } from "../shared/types";

interface GuestData {
  guests: Guest[];
  parties: GuestParty[];
}

const GUEST_LIST_SHEET = "Guest List";

const childColumnPairs = [
  ["Child 1 First Name", "Child 1 Last Name"],
  ["Child 2 First Name", "Child 2 Last Name"],
  ["Child 3 First Name", "Child 3 Last Name"],
  ["Child 4 First Name", "Child 4 Last Name"],
  ["Child 5 First Name", "Child 5 Last Name"],
] as const;

export async function loadGuestData(workbookPath: string): Promise<GuestData> {
  if (!existsSync(workbookPath)) {
    throw new Error(`Guest workbook not found at ${workbookPath}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);

  const worksheet = workbook.getWorksheet(GUEST_LIST_SHEET) ?? workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Guest workbook does not contain any sheets");
  }

  const headers = readHeaders(worksheet);

  const guests: Guest[] = [];
  const parties: GuestParty[] = [];

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const partyId = `party-${rowNumber}`;
    const relationship = cell(row, headers, "Relationship To Couple") || "Unspecified";
    const partyGuests: Guest[] = [];

    addGuest(partyGuests, {
      id: `guest-${rowNumber}-primary`,
      partyId,
      kind: "primary",
      relationship,
      title: cell(row, headers, "Title"),
      firstName: cell(row, headers, "First Name"),
      lastName: cell(row, headers, "Last Name"),
      suffix: cell(row, headers, "Suffix"),
    });

    addGuest(partyGuests, {
      id: `guest-${rowNumber}-partner`,
      partyId,
      kind: "partner",
      relationship,
      title: cell(row, headers, "Partner Title"),
      firstName: cell(row, headers, "Partner First Name"),
      lastName: cell(row, headers, "Partner Last Name"),
      suffix: cell(row, headers, "Partner Suffix"),
    });

    childColumnPairs.forEach(([firstColumn, lastColumn], childIndex) => {
      addGuest(partyGuests, {
        id: `guest-${rowNumber}-child-${childIndex + 1}`,
        partyId,
        kind: "child",
        relationship,
        title: "",
        firstName: cell(row, headers, firstColumn),
        lastName: cell(row, headers, lastColumn),
        suffix: "",
      });
    });

    if (partyGuests.length === 0) {
      continue;
    }

    guests.push(...partyGuests);
    parties.push({
      id: partyId,
      label: formatPartyLabel(partyGuests, rowNumber),
      relationship,
      guestIds: partyGuests.map((guest) => guest.id),
    });
  }

  return { guests, parties };
}

function readHeaders(worksheet: ExcelJS.Worksheet): Map<string, number> {
  const headers = new Map<string, number>();
  worksheet.getRow(1).eachCell((cellValue, columnNumber) => {
    const header = cellValue.text.trim();
    if (header) {
      headers.set(header, columnNumber);
    }
  });

  return headers;
}

function cell(row: ExcelJS.Row, headers: Map<string, number>, column: string): string {
  const columnNumber = headers.get(column);
  if (!columnNumber) {
    return "";
  }

  return row.getCell(columnNumber).text.trim();
}

interface AddGuestInput {
  id: string;
  partyId: string;
  kind: GuestKind;
  relationship: string;
  title: string;
  firstName: string;
  lastName: string;
  suffix: string;
}

function addGuest(guests: Guest[], input: AddGuestInput): void {
  const displayName = [input.firstName, input.lastName].filter(Boolean).join(" ").trim();
  const fullName = [input.title, displayName, input.suffix].filter(Boolean).join(" ").trim();

  if (!displayName && !fullName) {
    return;
  }

  guests.push({
    id: input.id,
    partyId: input.partyId,
    fullName: fullName || displayName,
    displayName: displayName || fullName,
    kind: input.kind,
    relationship: input.relationship,
  });
}

function formatPartyLabel(guests: Guest[], rowNumber: number): string {
  const adults = guests.filter((guest) => guest.kind !== "child").map((guest) => guest.displayName);
  const childCount = guests.filter((guest) => guest.kind === "child").length;
  const adultLabel = adults.length > 0 ? adults.join(" & ") : guests[0]?.displayName ?? `Party ${rowNumber}`;

  if (childCount === 0) {
    return adultLabel;
  }

  return `${adultLabel} + ${childCount} ${childCount === 1 ? "child" : "children"}`;
}
