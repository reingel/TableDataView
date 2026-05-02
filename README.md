# TableDataView

A Visual Studio Code extension that displays CSV, TSV, and other tabular text files as interactive tables with graph support.

## Features

### Table View
- Open any `.csv`, `.tsv`, `.txt`, or `.dat` file as an interactive table
- Automatic delimiter detection (comma, tab, semicolon, pipe, space)
- Automatic header detection — if the first row contains non-numeric values, it is used as column headers
- Virtual scrolling for large files with no row limit
- All columns are left-aligned

### Column Selection
- The first column (column 0) is always selected and pinned — it stays fixed while scrolling horizontally
- Click a column header or any cell to select that column (column 0 remains selected)
- **Shift+click** to select a range of columns
- **Ctrl/Cmd+click** to toggle individual columns in a multi-selection

### Navigation
- **Top** button: jump to the first row
- **Bottom** button: jump to the last row

### Graph View
- Select one or more columns, then click **Show Graph** or right-click and choose **Show graph**
- If column 0 is included in the selection alongside other columns, it is used as the X-axis
- Supports line and bar chart types (toggle button in the graph panel)
- Adjustable line width
- Click on the graph to show a crosshair and highlight the corresponding row in the table
- Decimation: large datasets (>2,000 points) are automatically downsampled for smooth rendering

## Usage

1. In the Explorer or Editor, right-click a supported file
2. Select **TableDataView: table view**
3. The file opens in a new panel as a table

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
