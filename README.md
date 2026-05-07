# Seating Chart Web App

A collaborative local-network seating chart maker. The server reads `export.xlsx`, exposes guest names and party grouping to the UI, and stores the shared seating chart in `data/seating-chart.json`.

There is intentionally no authentication. Anyone who can reach the app on the network can edit the chart.

## Features

- Round and rectangle table layouts.
- Configurable seat counts from 1 to 32 seats per table.
- Seat-count reductions are blocked when they would remove an occupied seat.
- One guest can only be assigned to one seat at a time.
- Guests can be marked ignored, which excludes vendors or other non-seated people from seating progress.
- Guest tags and notes for seating constraints like vendor, family, needs aisle, or do not seat near.
- Bulk guest actions for ignoring, including, and tagging many guests at once.
- Party-aware seating that moves all active party members to a selected table when capacity allows.
- Timestamped history snapshots with restore support for bad edits.
- Printable export view for seating charts and table assignments. Notes are hidden unless explicitly enabled.
- Connected browsers receive live updates through Socket.IO.
- Tables can be dragged around the shared canvas.
- Guest search supports name, party label, and relationship.
- Contact details from the workbook are not exposed to the frontend.

## Local Development

Install dependencies:

```sh
npm install
```

If this app was previously installed with floating `latest` versions, clear the old Vite 8/Rolldown install first:

```sh
rm -rf node_modules
npm install
```

Run the dev server:

```sh
npm run dev
```

Open `http://localhost:5173`. Other devices on the same network can use `http://<your-machine-ip>:5173` while the dev server is running.

## Local-Network Production Run

Build the frontend:

```sh
npm run build
```

Start the shared app instance:

```sh
HOST=0.0.0.0 PORT=3000 npm start
```

Open `http://<server-ip>:3000` from any device on the network.

## Configuration

- `GUEST_WORKBOOK`: path to the guest workbook. Defaults to `export.xlsx` in the project root.
- `STATE_FILE`: path to the saved chart JSON. Defaults to `data/seating-chart.json`.
- `HISTORY_DIR`: path to timestamped chart snapshots. Defaults to `data/history`.
- `HOST`: listen host. Defaults to `0.0.0.0`.
- `PORT`: listen port. Defaults to `3000`.

## Data Safety

The current seating chart is stored in `data/seating-chart.json`. Normal rebuilds do not remove this file.

Every successful edit also writes a timestamped snapshot to `data/history`. The app keeps the last 500 snapshots and anything from the last 30 days.

## Verification

```sh
npm test
npm run build
```
