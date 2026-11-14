# Changelog

## 3.0.0
- Large files: much faster response to column clicks, graph zoom/pan and table scrolling (numeric column cache, graph decimation, only visible columns rendered)
- Large files: about half the memory; numbers are sent to the view as binary columns and only the rows on screen are split into cells
- Large files: column context menu (stats), Go to max/min/NaN, Find next change and compare diff stats / Sync work on cached numeric columns
- Graph: columns with many blank/NaN cells no longer freeze the view (a gap is a break in one line, not a separate series)
- Compare: cells that differ only in number formatting (e.g. `1.50` vs `1.5`) are no longer marked as different; hex-displayed columns are no longer always marked as different

## 2.9.0
- Compare: files with different row counts show every row (shorter side padded with blank rows)
- Compare: scale / offset are independent per file
- Compare: "Sync with left/right data" aligns time by cross-correlation over the visible graph range; "Reset sync" undoes it
- Compare: Header panel shows differently named matched columns as `left ↔ right`
- Single Scale/Offset toggle button; Scale/Offset rows shown by default
- Header panel open by default
- First column click (table or Header panel) opens the graph automatically
- Toolbar "Graph" button toggles the graph; graph close button shows only ✕
- Graph "Save" button: export PNG (current view or 8 × 6 in, legend position, optional minimap)
- Opening a table / compare view closes the file's plain-text editor tab

## 2.8.1 — 2026-10-21
- Column index shown 0-based

## 2.8.0 — 2026-08-20
- TODO.md excluded from the package

## 2.7.0 — 2026-08-19
- Scale / Offset rows: show columns as value × scale + offset in table and graph
- Fix hovered-column glow alignment in compare view

## 2.6.0 — 2026-08-16
- Hovering a column highlights its line in the graph

## 2.5.0 — 2026-08-16
- Go to prev./next NaN and NaN count in column stats
- Find prev. change; Shift + ←/→ steps through value changes on an open graph
- Compare file picker opens in the right-clicked file's folder
- Marker style defaults to "."
- Fix graph click on data containing NaN

## 2.3.0 — 2026-07-21
- Compare: manual column matching (Match with… / Clear match)

## 2.2.0 — 2026-07-13
- Column width always fits the header text

## 2.1.0 — 2026-07-13
- Compare: "Select as left file" picker when only one file is selected
- Colored Header panel items

## 2.0.1 — 2026-07-04
- `npm run publish` support

## 2.0.0 — 2026-07-04
- Header column list panel (table and compare views)
- Redesigned toolbar buttons
- Compare: Swap button exchanges left / right files
- Fix phantom series in compare graph for right-only columns

## 1.9.1 — 2026-06-19
- Use row index as x-axis when the time column is transformed

## 1.9.0 — 2026-06-13
- Version bump

## 1.8.0 — 2026-06-13
- Zoom minimap on graph and FFT charts
- Column header search (space-separated terms are ANDed)
- FFT computed from the visible graph region only
- Header width as minimum column width; stable column widths while scrolling

## 1.7.0 — 2026-06-11
- Stream large files to the webview with a loading indicator

## 1.6.0 — 2026-06-04
- Use row index as x-axis when there is no time column

## 1.5.0 — 2026-05-23
- Show in hex
- Compare graph: plot L − R / R − L / |L − R|
- Color and bug fixes

## 1.3.0 — 2026-05-21
- Go to max. / min. value

## 1.2.0 — 2026-05-19
- Clicking the table places the graph crosshair
- Double-click resets graph zoom

## 1.1.0 — 2026-05-18
- Second crosshair with delta values

## 1.0.1 — 2026-05-18
- Fix graph y-axis autoscale

## 1.0.0 — 2026-05-17
- FFT pane
- Reload button

## 0.4.0 — 2026-05-15
- Compare view for two files

## 0.3.7 — 2026-05-14
- Graph follows table scrolling
- Moving average n=1000
- Fix zoom range

## 0.3.6 — 2026-05-13
- Graph zoom and pan
- Fix numerical difference direction

## 0.3.5 — 2026-05-11
- Right-click column menu
- Moving averages

## 0.3.0 — 2026-05-10
- Table viewport region shown in graph
- Keyboard scrolling shortcuts
- Column index row; Left / Right buttons
- "Table view" in the editor tab context menu
- Graph updates instantly on column selection

## 0.2.4 — 2026-05-10
- Horizontal scrollbar visible while the graph is open

## 0.2.3 — 2026-05-07
- Sticky first column and header row alignment

## 0.2.1 — 2026-05-04
- Bundled Chart.js for offline use

## 0.2.0 — 2026-05-04
- Extension icon

## 0.1.5 — 2026-05-02
- Time column always selected
- Top / Bottom buttons
- No row count limit

## 0.1.3 — 2026-05-02
- Faster rendering; opaque table header

## 0.1.1 — 2026-05-02
- Initial release: table view with column selection and graph
