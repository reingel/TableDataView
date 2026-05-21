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
- Virtual scrolling — handles large files with tens of thousands of rows smoothly
- Click a column header or any cell to select that column
  - **Shift+click** to select a range of columns
  - **Ctrl/Cmd+click** to toggle individual columns in a multi-selection
- **Mouse drag** to scroll the table in any direction

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

### Right-Click Context Menu

Right-click any cell to access column-specific actions:

| Menu item | Description |
|---|---|
| **Set as x-axis** | Sets the column as the X-axis for graphing (highlighted in orange). Hidden if already the X-axis. |
| **Reset x-axis** | Restores the default (leftmost) column as X-axis. Shown only when a custom X-axis is active. |
| **Show in hex** | Displays column values as hexadecimal with a `0x` prefix (highlighted in yellow). |
| **Show numerical differences** | Replaces values with row-to-row differences `value[k] − value[k−1]`; first row is set to 0 (highlighted in green). |
| **Show moving averages (n=10/30/100/1000)** | Replaces values with a rolling average over the last n rows (highlighted in blue). |
| **Show original values** | Restores the original data. Shown when hex, diff, or moving average is active. |
| **Find next change** | Scrolls to the next row where this column's value changes. |
| **Go to max. value** | Scrolls to the row with the maximum value in this column. |
| **Go to min. value** | Scrolls to the row with the minimum value in this column. |

At the bottom of the menu, column statistics are displayed (non-clickable):
- **max**, **min**, **max−min**, **mean** of the currently displayed values

### Toolbar

| Button | Description |
|---|---|
| **Top / Bottom / Left / Right** | Navigate to the edges of the table |
| **Show Graph** | Opens the graph panel for the selected columns |
| **Reset All** | Resets X-axis, hex, diff, and moving average for all columns. Shown only when any transform is active. |
| **Reload** | Reloads the file from disk, preserving current scroll position and transforms |

### Graph View

Select one or more columns, then click **Show Graph**.

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
- **Marker** style (none / dot / circle)
- **Hide Crosshair** — hides both crosshairs
- **Close** — closes the graph panel

---

## Compare View

Select two files in the Explorer, right-click, and choose **TableDataView: compare**.

### Layout
- The two files are displayed side-by-side with synchronized horizontal and vertical scrolling
- Cells where the two files differ are highlighted with a red background
- Drag the center divider to resize the left and right panes

### Column Matching
When the two files have different numbers of columns, columns are matched by header name using a multi-tier strategy:
1. Case-sensitive exact match
2. Best LCS (Longest Common Subsequence) similarity
3. Case-insensitive exact match
4. Case-insensitive LCS similarity

### Synchronized Operations
All transforms apply to both sides simultaneously:
- Column selection / deselection
- X-axis assignment
- Hex display
- Numerical differences
- Moving averages
- Scroll position

### Compare Right-Click Context Menu
Includes all the same items as the table view, plus:

| Menu item | Description |
|---|---|
| **Go to next different row** | Jumps to the next row where this column's values differ between the two files |
| **Go to prev. different row** | Jumps to the previous differing row |
| **Find max. difference row** | Jumps to the row with the largest absolute difference in this column |

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

### Compare View
1. In the **Explorer**, select two supported files (Ctrl/Cmd+click to multi-select)
2. Right-click and select **TableDataView: compare**

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
