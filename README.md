# TableDataView

A Visual Studio Code extension that displays CSV, TSV, and other tabular text files as interactive tables with graph and compare support.

## Features

### File Reading
- Supports `.csv`, `.tsv`, `.txt`, and `.dat` files
- Automatic delimiter detection (comma, tab, space, semicolon, pipe)
- Automatic header detection — if the first row contains non-numeric values, it is used as column headers

### Table View
- Row index column on the left and column index row at the top for easy reference
- First column is pinned (sticky) and stays visible while scrolling horizontally
- Virtual scrolling (rows and columns) — stays responsive on large files (tested with 430,000 rows × 140 columns)
- Click a column header, any cell, or a Header panel entry to toggle that column in / out of the selection — clicking another column adds it instead of replacing the selection
  - **Alt/Option+click** to select only that column (clears the others)
  - **Shift+click** to add a range of columns, starting from the last clicked column
  - **Esc** clears the selection
  - The X-axis column always stays selected
- **Mouse drag** to scroll the table in any direction
- The first column click (in the table or the Header panel) opens the graph for that column automatically
- Right-click the table view's tab and choose **Reveal in Explorer** to select the source file in the Explorer
- **Header** panel — a column list on the right, shown by default; toggle it with the **☰ Header** toolbar button. Click (Shift / Ctrl/Cmd) to select columns; right-click for the column menu

### Navigation
| Button / Shortcut | Action |
|---|---|
| **Top** | Jump to first row |
| **Bottom** | Jump to last row |
| **Left** | Scroll to leftmost column |
| **Right** | Scroll to rightmost column |
| **↑ / ↓** | Scroll 5 rows up / down |
| **← / →** | Scroll one column left / right |
| **Cmd/Ctrl + ↑** | Jump to top |
| **Cmd/Ctrl + ↓** | Jump to bottom |
| **Cmd/Ctrl + ←** | Jump to leftmost column |
| **Cmd/Ctrl + →** | Jump to rightmost column |
| **Shift + ← / →** | While the graph is open, steps the crosshair to the previous / next row where the last selected column's value changes (same as **Find prev./next change**) |

### Right-Click Context Menu

Right-click any cell to access column-specific actions:

| Menu item | Description |
|---|---|
| **Set as x-axis** | Sets the column as the X-axis for graphing (highlighted in orange). Hidden if already the X-axis. |
| **Reset x-axis** | Restores the default (leftmost) column as X-axis. Shown only when a custom X-axis is active. |
| **Show in hex** | Displays column values as hexadecimal with a `0x` prefix (highlighted in yellow). |
| **Show numerical differences** | Replaces values with row-to-row differences `value[k] − value[k−1]`; first row is set to 0 (highlighted in green). |
| **Show moving averages (n=10/30/100/1000)** | Replaces values with a rolling average over the last n rows (highlighted in blue). |
| **Show original values** | Restores the original data, including resetting scale to 1.0 and offset to 0.0. Shown when hex, diff, moving average, scale, or offset is active. |
| **Find prev. change** | Scrolls to the previous row where this column's value changes. |
| **Find next change** | Scrolls to the next row where this column's value changes. |
| **Go to max. value** | Scrolls to the row with the maximum value in this column. |
| **Go to min. value** | Scrolls to the row with the minimum value in this column. |
| **Go to prev. NaN** | Scrolls to the previous row whose value is not a finite number (`NaN`, empty, `Infinity`), wrapping around at the top. Shown only when the column has both numbers and NaNs. |
| **Go to next NaN** | Same, searching downwards. |

At the bottom of the menu, column statistics are displayed (non-clickable):
- **max**, **min**, **max−min**, **mean**, and the **NaN** count of the currently displayed values

### Toolbar

| Button | Description |
|---|---|
| **Top / Bottom / Left / Right** | Navigate to the edges of the table |
| **Scale/Offset** | Shows / hides the **Scale** and **Offset** rows under the header (shown by default), one editable cell per column (defaults `1.0` / `0.0`) |
| **Graph** | Toggles the graph panel for the selected columns (also closable with **✕** on the graph panel) |
| **Reset All** | Resets X-axis, hex, diff, moving average, scale, and offset for all columns. Shown only when any transform is active. |
| **Reload** | Reloads the file from disk, preserving current scroll position and transforms |

### Scale and Offset

Two editable rows sit directly under the header (Scale, then Offset); they are shown when a
view opens and **Scale/Offset** in the toolbar hides or shows them. Type a value into any column's cell and press Enter: the table and
the graph then show `value x scale + offset`, and the adjusted column is highlighted in purple.
Values start at `1.0` / `0.0`, and hiding the rows resets both factors for every column.

Scale and offset stack on top of the diff / moving-average transforms and are preserved by
**Reload**. In compare view, scale and offset are independent per file: editing one side does not change
the matched column on the other side.

### File Formats and Column Presets
Files with the same header layout (e.g. every CSV from one logger) are treated as one **file format**, recognised when at least 80% of the columns match. Each format is a `.json` file in the preset folder (setting `tableDataView.presetFolder`, default `~/.tabledataview/presets`).
- **Scale/Offset** — when a file of a known format is opened, the format's saved Scale/Offset values are applied right away. Every Scale/Offset edit (typing a value, *Show original values*) is saved back to the format; hiding the rows or *Reset All* only resets the view. A file with no matching format gets a new format (named after the file) on its first edit or saved selection.
- **Column selections** — the toolbar pull-down (`Format: <name>`) lists the format's saved selections as `name (found/saved)`; pick one to select those columns. The pull-down then shows that selection until you change the column selection. *Save current selection…* stores the selected columns under a name; for the selection shown, *Rename…*, *Move up / down* (order in the list) and *Delete…* are offered. *Rename format…* renames the format (and its `.json` file when that name is free); for a file with no format yet it reads *Name this format…* and creates the format's `.json` file under the entered name. *Open format file (.json)* opens it in an editor; once saved, edits show up in the pull-down (Scale/Offset applies the next time a file is opened).
- **Axis titles** — double-click the graph's x or y axis title to edit it (Enter / clicking away saves, Esc cancels, empty restores the default). The x title is saved with the format for the current x-axis column; the y title is saved with the selection shown in the pull-down — with none shown, you are asked to name the current columns as a selection first.
- Columns are stored by header name and matched in this order, the first stage with exactly one candidate winning: same case and whole name → same case, name contained → any case, name contained. A name that matches no column, or several, is skipped with a message.

### Graph View

Select one or more columns, then click **Graph**. The first column click in a newly opened view opens the graph automatically.

**Graph interactions:**

| Action | Result |
|---|---|
| Left-click | Places a crosshair and scrolls the table to that row |
| Right-click | Places a second crosshair; displays delta values between the two crosshairs |
| Left-drag | Zooms into the selected X range; Y range auto-fits the visible data |
| Double-click | Resets zoom to show all data |
| Mouse wheel | Zooms in/out around the cursor position |
| Right-drag (or Ctrl/Cmd+left-drag) | Pans the view |

**Graph features:**
- The X-axis column (highlighted in orange) is used as X; all other selected columns are plotted as Y
- True XY graph with a linear numeric X-axis — supports non-uniform and multi-valued data
- A semi-transparent viewport box on the graph shows which rows are currently visible in the table; updates in real time as you scroll
- **Show FFT** — opens an FFT pane below the graph for the displayed data; resizable independently
- Resizable graph panel — drag the top edge to adjust height
- Adjustable **Line width** (0.5 / 1.0 / 1.5 / 2.0 / 3.0)
- **Marker** style (none / `.` / `o`) — defaults to `.`
- **Hide Crosshair** — hides both crosshairs
- **Legend** — legend position (top / right / bottom / left), next to *Marker*; also used by *Save*.
- **Save** — saves the graph as a PNG. Options: size (current view, or 8 × 6 in at 150 dpi = 1200 × 900 px) and minimap (off by default); the legend is placed as set in the toolbar. The image keeps the visible x/y range and uses a white background; a file dialog asks for the file name.
- **✕** — closes the graph panel (the toolbar **Graph** button toggles it too)

---

## Compare View

Select two files in the Explorer, right-click, and choose **TableDataView: compare**.

### Layout
- The two files are displayed side-by-side with synchronized horizontal and vertical scrolling
- Cells where the two files differ are highlighted with a red background. Numbers are compared by value, so `1.50` and `1.5` count as equal; text cells (dates, labels) are compared as text
- Drag the center divider to resize the left and right panes
- When the files have different row counts, every row of both files is shown; the shorter side is padded with blank rows so scrolling stays aligned, and values are compared only over the rows both files have

### Column Matching
When the two files have different numbers of columns, columns are matched by header name using a multi-tier strategy:
1. Case-sensitive exact match
2. Best LCS (Longest Common Subsequence) similarity
3. Case-insensitive exact match
4. Case-insensitive LCS similarity

If a match is wrong or missing, use **Match with…** in the column's right-click menu to pick the column on the other side, or **Clear match** to unpair it. Manual matches survive **Reload** while the headers stay the same. In the Header panel, a pair whose names differ is shown as `left ↔ right`, updated as soon as the matching changes.

### Synchronized Operations
All transforms apply to both sides simultaneously:
- Column selection / deselection
- X-axis assignment
- Hex display
- Numerical differences
- Moving averages
- Scroll position

Scale / offset values are independent per file (the Scale/Offset toggle itself is shared).

### Compare Right-Click Context Menu
Includes the same items as the table view (except **Find prev./next change**), plus:

| Menu item | Description |
|---|---|
| **Match with…** / **Clear match** | Manually pairs this column with a column on the other side, or removes the pairing |
| **Go to next different row** | Jumps to the next row where this column's values differ between the two files |
| **Go to prev. different row** | Jumps to the previous differing row |
| **Find max. difference row** | Jumps to the row with the largest absolute difference in this column |
| **Sync with right data** / **Sync with left data** | Finds the time shift with the highest correlation between this column and its matched column on the other side, using the x range visible in the graph (the other file's full range if the graph is closed), and writes it to the **Offset** of this side's x-axis column. Shown only when both sides use an untransformed time column as x-axis. |
| **Reset sync** | Sets this side's x-axis column **Offset** back to `0.0`. Shown only when that offset is non-zero, on data columns and on the x-axis column itself. |

### Compare Graph
Both files are plotted together — left-file series use solid lines, right-file series use dashed lines with offset colors.

The **Select** dropdown in the graph header controls what is plotted:

| Option | Plot |
|---|---|
| **original** | Both L and R data as-is |
| **L − R** | Per-column difference (left minus right) |
| **R − L** | Per-column difference (right minus left) |
| **\|L − R\|** | Absolute difference |

All graph interactions (zoom, pan, crosshair, FFT) work the same as in the single-file graph view.

---

## Usage

### Table View
1. In the **Explorer** or **Editor tab**, right-click a supported file
2. Select **TableDataView: table view**

If the file is also open as a plain-text editor tab (e.g. from a single click in the Explorer), that tab is closed when the table view opens. Tabs with unsaved edits are left open.

### Compare View
1. In the **Explorer**, select two supported files (Ctrl/Cmd+click to multi-select)
2. Right-click and select **TableDataView: compare**

As with the table view, plain-text editor tabs of the compared files are closed when the compare view opens (unless they have unsaved edits).

With only one file selected, the same menu item opens a file picker — starting in that file's own folder — to choose the file for the left pane; the file you right-clicked becomes the right pane.

### Supported File Extensions

| Extension | Typical delimiter |
|-----------|------------------|
| `.csv`    | Comma            |
| `.tsv`    | Tab              |
| `.txt`    | Auto-detected    |
| `.dat`    | Auto-detected    |

## Requirements

- Visual Studio Code `^1.85.0`

## License

[MIT](LICENSE.md)
