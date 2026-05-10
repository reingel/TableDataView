# TableDataView

A Visual Studio Code extension that displays CSV, TSV, and other tabular text files as interactive tables with graph support.

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

### Navigation
| Button / Shortcut | Action |
|---|---|
| **Top** | Jump to first row |
| **Bottom** | Jump to last row |
| **Left** | Scroll to leftmost column |
| **Right** | Scroll to rightmost column |
| **↑ / ↓** | Scroll 5 rows up / down (snaps to row boundary) |
| **← / →** | Scroll one column left / right (snaps to column boundary) |
| **Cmd/Ctrl + ↑** | Jump to top |
| **Cmd/Ctrl + ↓** | Jump to bottom |
| **Cmd/Ctrl + ←** | Jump to leftmost column |
| **Cmd/Ctrl + →** | Jump to rightmost column |

### Right-Click Context Menu

Right-click any cell to access column-specific actions:

- **Set as x-axis** — Sets the clicked column as the X-axis for graphing. The X-axis column is highlighted in a distinct color. Hidden if the column is already the X-axis.
- **Reset x-axis** — Restores the default (leftmost) column as X-axis. Shown only when a custom X-axis is active and you right-click on it.
- **Show numerical differences** — Replaces column values with row-to-row differences (`value[k] − value[k−1]`; first row is set to 0). Diff columns are highlighted in a distinct color. Hidden if the column is already in diff mode.
- **Show original values** — Restores original data for a column in diff mode. Hidden if the column is already showing original values.

### Toolbar

- **Show Graph** — Opens the graph panel for the currently selected columns.
- **Reset All** — Appears when a custom X-axis or any diff column is active. Resets the X-axis to default and restores all diff columns to original values.

### Graph View
- Select one or more columns and click **Show Graph**
- The X-axis column (highlighted in orange) is used as the X-axis; all other selected columns are plotted as Y values
- True XY graph with a linear numeric X-axis — supports multi-valued functions
- Graph crosshair: click anywhere on the graph to highlight the corresponding row in the table and display Y values
- The currently visible table region is shown as a semi-transparent box on the graph; updates in real time as you scroll
- Resizable graph panel — drag the top edge to resize
- Adjustable line width
- Large datasets (>2,000 points) are automatically decimated for smooth rendering

## Usage

1. In the **Explorer** or **Editor tab**, right-click a supported file
2. Select **TableDataView: table view**
3. The file opens in a new panel as an interactive table

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
