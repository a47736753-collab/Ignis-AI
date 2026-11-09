# CSV upload format

The columns are exactly the inputs of the existing scoring engine (`public/scoring.js`). Names, units and ranges below
are enforced by the server (`server/csv.js`); the browser only previews.

| Column | Unit | Allowed range | Meaning |
|---|---|---|---|
| `zone_id` | text | `A1` to `D6` | zone (row letter A-D, column 1-6). Case-insensitive |
| `date` | `YYYY-MM-DD` | real calendar date, 2000-2100 | the day this observation applies to |
| `temp_c` | degrees C | -30 to 60 | air temperature |
| `humidity_pct` | percent | 0 to 100 | relative humidity (a percent, not a 0-1 fraction) |
| `wind_kmh` | km/h | 0 to 200 | wind speed |
| `ndvi` | index | -1 to 1 | vegetation index; lower = drier vegetation |
| `fire_history` | index | 0 to 1 | normalised fire-history index. 0 = no recorded recurrence, 1 = highest. **Not a count of fires** |

Header: `zone_id,date,temp_c,humidity_pct,wind_kmh,ndvi,fire_history` (order does not matter; extra columns are ignored with a warning).

## Rules

- **One row per zone per date**: the final observed values for that zone-day. The engine's built-in demo day-to-day
  offsets are **not** added to uploaded values.
- **Every one of the 24 zones needs a row for every date**, and the file covers **1 to 7 consecutive dates**. Uploaded data
  is never mixed with demo data, so partial files are rejected with a list of what is missing.
- No blanks, non-numeric text, values outside the ranges, malformed dates, unknown zones or duplicate zone+date pairs.
  Nothing is repaired or filled in; each problem is reported with its line number (first 50 shown, total counted).
- Limits (server-enforced, configurable): 200 KB, 500 data rows, 25 saved datasets per user.
- Plain comma-separated UTF-8 text, quotes allowed (RFC 4180 style). Binary files are rejected.

## How the values are used

Each row goes straight into the same formula as the demo data. Values beyond the engine's normalisation band (for example
temperature above 44 C) are accepted, but they saturate at the top of the scale exactly as the formula defines.

## Templates

- *Blank template*: header plus 168 rows (24 zones x 7 days starting tomorrow) with **empty measurement cells**. It fails
  validation until you fill every cell with your own observations. That is intentional.
- *Example with synthetic demo values*: the demo forecast exported as a CSV, named `...SYNTHETIC...`, to test the pipeline.
  These are not real measurements.
