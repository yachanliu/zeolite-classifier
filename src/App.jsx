import * as React from "react";
import Papa from "papaparse";
import { useVirtualizer } from "@tanstack/react-virtual";

// CLEAN, WORKING VERSION — Single table with sticky header & spacer-row virtualization
// Place zeolites.csv in /public (headers: zeolite, target, prediction, prob_PCOD, prob_Si, Prob_P, prob_Si/P)

export default function App() {
  // UI & state
  const [status, setStatus] = React.useState("Loading bundled CSV …");
  const [loading, setLoading] = React.useState(true);
  const [nameQuery, setNameQuery] = React.useState("");
  const [pendingName, setPendingName] = React.useState("");
  const [targetFilter, setTargetFilter] = React.useState("");
  const [predictionFilter, setPredictionFilter] = React.useState("");
  
  // Application filter state for built-in CSV files
  const [applicationFilter, setApplicationFilter] = React.useState("");
  const [applicationZeolites, setApplicationZeolites] = React.useState(new Set());
  const [applicationData, setApplicationData] = React.useState([]);
  const [applicationColumns, setApplicationColumns] = React.useState([]);
  
  // Application files available for filtering
  const applicationFiles = React.useMemo(() => [
    { value: "Bai2015.csv", label: "Bai2015" },
    { value: "Hewitt2022.csv", label: "Hewitt2022" },
    { value: "Kim2013.csv", label: "Kim2013" },
    { value: "Kristof2024.csv", label: "Kristof2024" },
    { value: "Simon2015.csv", label: "Simon2015" }
  ], []);
  
  // Custom filter state for uploaded CSV
  const [uploadedZeolites, setUploadedZeolites] = React.useState(new Set());
  const [uploadedData, setUploadedData] = React.useState([]); // Store full uploaded CSV data
  const [uploadedColumns, setUploadedColumns] = React.useState([]); // Store column definitions for uploaded data
  const [uploadStatus, setUploadStatus] = React.useState("");
  const [uploadedFileName, setUploadedFileName] = React.useState("");
  const fileInputRef = React.useRef(null);
  
  React.useEffect(() => { setPendingName(nameQuery); }, [nameQuery]);

  // Columnar storage for speed
  const [dataCols, setDataCols] = React.useState(null); // { Z,T,Pred,PSi,PP,PSIP,PPCOD }
  const [index, setIndex] = React.useState([]);         // filtered/sorted indices

  // Column definitions & widths - reduced for better fit
  const columns = React.useMemo(() => ([
    { id: 'zeolite',  header: 'Zeolite',   fmt: (v) => v ?? '' },
    { id: 'target',   header: 'Target',    fmt: (v) => v ?? '' },
    { id: 'prediction', header: 'Prediction', fmt: (v) => v ?? '' },
    { id: 'prob_Si',  header: 'P(Si-only)',     fmt: (v) => num(v), numeric: true },
    { id: 'Prob_P',   header: 'P(P-only)',      fmt: (v) => num(v), numeric: true },
    { id: 'prob_Si/P',header: 'P(Si/P)',   fmt: (v) => num(v), numeric: true },
    { id: 'prob_PCOD',header: 'P(PCOD)',   fmt: (v) => num(v), numeric: true },
  ]), []);
  const COL_WIDTHS = React.useMemo(() => [180, 100, 120, 90, 90, 90, 90], []);

  // Combined columns (original + uploaded + application)
  const allColumns = React.useMemo(() => {
    const baseColumns = [...columns];
    const uploadedCols = uploadedColumns.map(col => ({
      id: col.id,
      header: col.header,
      fmt: (v) => formatUploadedValue(v),
      numeric: col.numeric,
      isUploaded: true
    }));
    const applicationCols = applicationColumns.map(col => ({
      id: col.id,
      header: col.header,
      fmt: (v) => formatUploadedValue(v),
      numeric: col.numeric,
      isApplication: true
    }));
    return [...baseColumns, ...uploadedCols, ...applicationCols];
  }, [columns, uploadedColumns, applicationColumns]);

  // Combined column widths - adaptive sizing
  const allColumnWidths = React.useMemo(() => {
    const baseWidths = [...COL_WIDTHS];
    const uploadedWidths = uploadedColumns.map(() => 80); // Narrower for uploaded columns
    const applicationWidths = applicationColumns.map(() => 80); // Narrower for application columns
    return [...baseWidths, ...uploadedWidths, ...applicationWidths];
  }, [uploadedColumns, applicationColumns]);

  // Sorting
  const [sort, setSort] = React.useState({ col: null, dir: 1 }); // dir: 1 asc, -1 desc
  const requestSort = (colId) => setSort((s) => ({ col: colId, dir: s.col === colId ? -s.dir : 1 }));

  const containerRef = React.useRef(null);

  // Initial load
  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch("zeolites.csv");
        const text = await res.text();
        parseCsvText(text);
      } catch (err) {
        console.error(err);
        setStatus("Failed to load CSV");
        setLoading(false);
      }
    })();
  }, []);

  // Parse CSV (worker) → column arrays
  const parseCsvText = (csvText) => {
    setStatus("Parsing CSV …");
    const Z = []; const T = []; const Pred = [];
    const PSi = []; const PP = []; const PSIP = []; const PPCOD = [];

    let kZ, kT, kPred, kSi, kP, kSiP, kPCOD;
    const resolveKeys = (fields, sample) => {
      const keys = fields?.length ? fields : Object.keys(sample || {});
      const pick = (regexes) => {
        for (const rx of regexes) for (const k of keys) if (rx.test(k)) return k;
        for (const rx of regexes) for (const k of keys) if (rx.test(k.toLowerCase())) return k; // case-insensitive fallback
        return undefined;
      };
      kZ    = pick([/^(zeolite|zeolites)$/i]) || 'zeolite';
      kT    = pick([/^target$/i]) || 'target';
      kPred = pick([/^prediction$/i]) || 'prediction';
      kSi   = pick([/^prob[_-]?si$/i, /probability.*si/i]) || 'prob_Si';
      kP    = pick([/^prob[_-]?p$/i, /probability.*\bp\b/i]) || 'Prob_P';
      kSiP  = pick([/^prob[_-]?si\/?p$/i, /prob.*si\/?p/i]) || 'prob_Si/P';
      kPCOD = pick([/^prob[_-]?pcod$/i, /probability.*pcod/i]) || 'prob_PCOD';
    };

    Papa.parse(csvText, {
      header: true, skipEmptyLines: true, dynamicTyping: true, worker: true,
      chunk: (res) => {
        if (!kZ) resolveKeys(res.meta?.fields, res.data[0]);
        for (const r of res.data) {
          Z.push(r[kZ] ?? '');
          T.push(r[kT] ?? '');
          Pred.push(r[kPred] ?? '');
          PSi.push(toNum(r[kSi]));
          PP.push(toNum(r[kP]));
          PSIP.push(toNum(r[kSiP]));
          PPCOD.push(toNum(r[kPCOD]));
        }
        setStatus(`Parsed ~${Z.length.toLocaleString()} rows…`);
      },
      complete: () => {
        const n = Z.length; const idx = new Array(n); for (let i=0;i<n;i++) idx[i]=i;
        setDataCols({ Z,T,Pred,PSi,PP,PSIP,PPCOD });
        setIndex(idx);
        setLoading(false);
        setStatus(`Loaded ${n.toLocaleString()} structures`);
      },
      error: (err) => { console.error(err); setLoading(false); setStatus(`Parse error: ${err.message}`); },
    });
  };

  // Parse application CSV for zeolite names and additional columns
  const parseApplicationCsv = async (filename) => {
    try {
      setUploadStatus(`Loading ${filename}...`);
      const response = await fetch(filename);
      const csvText = await response.text();
      
      const zeoliteNames = new Set();
      const applicationRows = [];
      let headers = [];

      Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
        chunk: (res) => {
          if (headers.length === 0) {
            headers = res.meta?.fields || [];
          }
          
          // Try to find zeolite column
          const zeoliteCol = headers.find(h => 
            /^(zeolite|zeolites|name|structure)$/i.test(h) ||
            /zeolite/i.test(h)
          );
          
          for (const row of res.data) {
            const rowData = {};
            let zeoliteName = '';
            
            // Process all columns
            for (const header of headers) {
              const value = row[header];
              rowData[header] = value ?? '';
              
              // Extract zeolite name for filtering
              if (zeoliteCol && header === zeoliteCol) {
                zeoliteName = String(value ?? '').trim();
              } else if (!zeoliteCol && header === headers[0]) {
                // If no clear zeolite column, use first column
                zeoliteName = String(value ?? '').trim();
              }
            }
            
            if (zeoliteName) {
              zeoliteNames.add(zeoliteName);
              applicationRows.push(rowData);
            }
          }
        },
        complete: () => {
          setApplicationZeolites(zeoliteNames);
          setApplicationData(applicationRows);
          
          // Create column definitions for application data with numeric detection
          const applicationCols = headers
            .filter(header => !/^(zeolite|zeolites|name|structure)$/i.test(header) && !/zeolite/i.test(header))
            .map(header => {
              // Detect if column contains numeric data
              const isNumeric = applicationRows.some(row => {
                const value = row[header];
                return value != null && value !== '' && !isNaN(Number(value));
              });
              
              return {
                id: header,
                header: header,
                fmt: (v) => formatUploadedValue(v),
                numeric: isNumeric
              };
            });
          
          setApplicationColumns(applicationCols);
          const label = applicationFiles.find(f => f.value === filename)?.label || filename;
          setUploadStatus(`Loaded ${zeoliteNames.size} zeolites from ${label} with ${applicationCols.length} additional columns`);
        },
        error: (err) => {
          console.error(err);
          setUploadStatus(`Error parsing ${filename}: ${err.message}`);
        },
      });
    } catch (err) {
      console.error(err);
      setUploadStatus(`Error loading ${filename}: ${err.message}`);
    }
  };

  // Handle application filter change
  const handleApplicationFilterChange = (event) => {
    const selectedFile = event.target.value;
    setApplicationFilter(selectedFile);
    
    if (selectedFile) {
      parseApplicationCsv(selectedFile);
    } else {
      // Clear application filter
      setApplicationZeolites(new Set());
      setApplicationData([]);
      setApplicationColumns([]);
      setUploadStatus("");
    }
  };

  // Parse uploaded CSV for zeolite names and additional columns
  const parseUploadedCsv = (file) => {
    setUploadStatus("Parsing uploaded CSV...");
    const zeoliteNames = new Set();
    const uploadedRows = [];
    let headers = [];

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true, // Enable dynamic typing for uploaded CSV
      chunk: (res) => {
        if (headers.length === 0) {
          headers = res.meta?.fields || [];
        }
        
        // Try to find zeolite column
        const zeoliteCol = headers.find(h => 
          /^(zeolite|zeolites|name|structure)$/i.test(h) ||
          /zeolite/i.test(h)
        );
        
        for (const row of res.data) {
          const rowData = {};
          let zeoliteName = '';
          
          // Process all columns
          for (const header of headers) {
            const value = row[header];
            rowData[header] = value ?? '';
            
            // Extract zeolite name for filtering
            if (zeoliteCol && header === zeoliteCol) {
              zeoliteName = String(value ?? '').trim();
            } else if (!zeoliteCol && header === headers[0]) {
              // If no clear zeolite column, use first column
              zeoliteName = String(value ?? '').trim();
            }
          }
          
          if (zeoliteName) {
            zeoliteNames.add(zeoliteName);
            uploadedRows.push(rowData);
          }
        }
      },
      complete: () => {
        setUploadedZeolites(zeoliteNames);
        setUploadedData(uploadedRows);
        
        // Create column definitions for uploaded data with numeric detection
        const uploadedCols = headers
          .filter(header => !/^(zeolite|zeolites|name|structure)$/i.test(header) && !/zeolite/i.test(header))
          .map(header => {
            // Detect if column contains numeric data
            const isNumeric = uploadedRows.some(row => {
              const value = row[header];
              return value != null && value !== '' && !isNaN(Number(value));
            });
            
            return {
              id: header,
              header: header,
              fmt: (v) => formatUploadedValue(v),
              numeric: isNumeric
            };
          });
        
        setUploadedColumns(uploadedCols);
        setUploadStatus(`Loaded ${zeoliteNames.size} zeolites from ${file.name} with ${uploadedCols.length} additional columns`);
        setUploadedFileName(file.name);
      },
      error: (err) => {
        console.error(err);
        setUploadStatus(`Error parsing ${file.name}: ${err.message}`);
      },
    });
  };

  // Handle file upload
  const handleFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (file && file.type === 'text/csv') {
      parseUploadedCsv(file);
    } else if (file) {
      setUploadStatus("Please upload a CSV file");
    }
  };

  // Clear uploaded filter
  const clearUploadedFilter = () => {
    setUploadedZeolites(new Set());
    setUploadedData([]);
    setUploadedColumns([]);
    setUploadStatus("");
    setUploadedFileName("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Export filtered results to CSV
  const exportFilteredResults = () => {
    if (!dataCols || index.length === 0) {
      setUploadStatus("No data to export");
      return;
    }

    const { Z, T, Pred, PSi, PP, PSIP, PPCOD } = dataCols;
    const exportData = [];
    
    // Create header row
    const headers = [
      'Zeolite', 'Target', 'Prediction', 'P(Si-only)', 'P(P-only)', 'P(Si/P)', 'P(PCOD)'
    ];
    
    // Add uploaded column headers if any
    if (uploadedColumns.length > 0) {
      headers.push(...uploadedColumns.map(col => col.header));
    }
    
    // Add application column headers if any
    if (applicationColumns.length > 0) {
      headers.push(...applicationColumns.map(col => col.header));
    }
    
    exportData.push(headers);
    
    // Create data rows
    for (const idx of index) {
      const row = [
        Z[idx] ?? '',
        T[idx] ?? '',
        Pred[idx] ?? '',
        PSi[idx] ?? '',
        PP[idx] ?? '',
        PSIP[idx] ?? '',
        PPCOD[idx] ?? ''
      ];
      
      // Add uploaded data if available
      if (uploadedData.length > 0) {
        const zeoliteName = Z[idx];
        const uploadedRow = uploadedData.find(row => {
          // Find matching row by zeolite name
          const zeoliteCol = Object.keys(row).find(key => 
            /^(zeolite|zeolites|name|structure)$/i.test(key) || /zeolite/i.test(key)
          );
          return zeoliteCol ? row[zeoliteCol] === zeoliteName : false;
        });
        
        if (uploadedRow) {
          // Add uploaded columns in the same order as headers
          for (const col of uploadedColumns) {
            row.push(uploadedRow[col.id] ?? '');
          }
        } else {
          // Fill with empty values if no match found
          for (const col of uploadedColumns) {
            row.push('');
          }
        }
      }
      
      // Add application data if available
      if (applicationData.length > 0) {
        const zeoliteName = Z[idx];
        const applicationRow = applicationData.find(row => {
          // Find matching row by zeolite name
          const zeoliteCol = Object.keys(row).find(key => 
            /^(zeolite|zeolites|name|structure)$/i.test(key) || /zeolite/i.test(key)
          );
          return zeoliteCol ? row[zeoliteCol] === zeoliteName : false;
        });
        
        if (applicationRow) {
          // Add application columns in the same order as headers
          for (const col of applicationColumns) {
            row.push(applicationRow[col.id] ?? '');
          }
        } else {
          // Fill with empty values if no match found
          for (const col of applicationColumns) {
            row.push('');
          }
        }
      }
      
      exportData.push(row);
    }
    
    // Convert to CSV string
    const csvContent = exportData.map(row => 
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    
    // Download CSV file
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `filtered_zeolites_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    setUploadStatus(`Exported ${index.length} filtered results to CSV`);
  };

  // Extract unique values for dropdowns
  const uniqueTargets = React.useMemo(() => {
    if (!dataCols) return [];
    const targets = [...new Set(dataCols.T.filter(v => v != null && v !== ''))];
    return targets.sort();
  }, [dataCols]);

  const uniquePredictions = React.useMemo(() => {
    if (!dataCols) return [];
    const predictions = [...new Set(dataCols.Pred.filter(v => v != null && v !== ''))];
    return predictions.sort();
  }, [dataCols]);

  // Get value for a specific row and column (for sorting)
  const getValueForSorting = (rowIndex, colId) => {
    // Check if it's an original column
    const originalCol = getCol(dataCols, colId);
    if (originalCol && originalCol.length > 0) {
      return originalCol[rowIndex];
    }
    
    // Check if it's an uploaded column
    const uploadedCol = uploadedColumns.find(col => col.id === colId);
    if (uploadedCol && uploadedData.length > 0) {
      const zeoliteName = dataCols?.Z[rowIndex];
      
      // Find matching uploaded data
      const uploadedRow = uploadedData.find(row => {
        const zeoliteCol = Object.keys(row).find(key => 
          /^(zeolite|zeolites|name|structure)$/i.test(key) || /zeolite/i.test(key)
        );
        return zeoliteCol ? row[zeoliteCol] === zeoliteName : false;
      });
      
      if (uploadedRow) {
        const rawValue = uploadedRow[colId];
        // Convert to number if it's a numeric column, otherwise keep as string
        if (uploadedCol.numeric && rawValue != null && rawValue !== '') {
          const numValue = Number(rawValue);
          return isNaN(numValue) ? rawValue : numValue;
        } else {
          return rawValue;
        }
      }
    }
    
    // Check if it's an application column
    const applicationCol = applicationColumns.find(col => col.id === colId);
    if (applicationCol && applicationData.length > 0) {
      const zeoliteName = dataCols?.Z[rowIndex];
      
      // Find matching application data
      const applicationRow = applicationData.find(row => {
        const zeoliteCol = Object.keys(row).find(key => 
          /^(zeolite|zeolites|name|structure)$/i.test(key) || /zeolite/i.test(key)
        );
        return zeoliteCol ? row[zeoliteCol] === zeoliteName : false;
      });
      
      if (applicationRow) {
        const rawValue = applicationRow[colId];
        // Convert to number if it's a numeric column, otherwise keep as string
        if (applicationCol.numeric && rawValue != null && rawValue !== '') {
          const numValue = Number(rawValue);
          return isNaN(numValue) ? rawValue : numValue;
        } else {
          return rawValue;
        }
      }
    }
    
    return null;
  };

  // Filter and sort data
  React.useEffect(() => {
    if (!dataCols) return;
    
    const q = nameQuery.trim().toLowerCase();
    const { Z, T, Pred } = dataCols;
    const n = Z.length;
    
    console.log('Filtering with query:', q, 'Total rows:', n, 'Uploaded zeolites:', uploadedZeolites.size, 'Application zeolites:', applicationZeolites.size);
    
    // First, filter the data
    let filteredIndices;
    if (!q && !targetFilter && !predictionFilter && uploadedZeolites.size === 0 && applicationZeolites.size === 0) {
      // No filters - include all indices
      filteredIndices = new Array(n);
      for (let i = 0; i < n; i++) filteredIndices[i] = i;
      console.log('No filter applied, showing all', n, 'rows');
    } else {
      // Apply filters
      filteredIndices = [];
      for (let i = 0; i < n; i++) {
        let matches = true;
        
        // Zeolite name filter
        if (q) {
          const zeoliteValue = Z[i];
          const zeoliteName = String(zeoliteValue ?? '').toLowerCase();
          if (!zeoliteName.includes(q)) matches = false;
        }
        
        // Target filter
        if (targetFilter && T[i] !== targetFilter) {
          matches = false;
        }
        
        // Prediction filter
        if (predictionFilter && Pred[i] !== predictionFilter) {
          matches = false;
        }
        
        // Custom uploaded zeolites filter
        if (uploadedZeolites.size > 0) {
          const zeoliteValue = Z[i];
          const zeoliteName = String(zeoliteValue ?? '').trim();
          if (!uploadedZeolites.has(zeoliteName)) {
            matches = false;
          }
        }
        
        // Application zeolites filter
        if (applicationZeolites.size > 0) {
          const zeoliteValue = Z[i];
          const zeoliteName = String(zeoliteValue ?? '').trim();
          if (!applicationZeolites.has(zeoliteName)) {
            matches = false;
          }
        }
        
        if (matches) {
          filteredIndices.push(i);
        }
      }
      console.log('Filtered to', filteredIndices.length, 'rows matching filters');
    }
    
    // Then, apply sorting if a column is selected
    if (sort.col) {
      filteredIndices.sort((ia, ib) => {
        const aVal = getValueForSorting(ia, sort.col);
        const bVal = getValueForSorting(ib, sort.col);
        return cmp(aVal, bVal) * sort.dir;
      });
      console.log('Applied sorting by column:', sort.col);
    }
    
    setIndex(filteredIndices);
  }, [nameQuery, dataCols, sort, targetFilter, predictionFilter, uploadedZeolites, uploadedData, uploadedColumns, applicationZeolites, applicationData, applicationColumns]);

  // When the filter changes, reset scroll/virtualizer so we don't land in empty space
  React.useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.scrollTop = 0;
    try { rowVirtualizer.scrollToIndex?.(0); } catch {}
  }, [nameQuery, index.length, uploadedZeolites, applicationZeolites]);

  // Virtualizer (single scrolling table)
  const rowVirtualizer = useVirtualizer({
    count: index.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 34,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <div className="wrap">
      <h1>ZeoNet: Zeolite Synthetic Feasibility Viewer</h1>
      <div className="status">{status}</div>
      {uploadStatus && <div className="upload-status">{uploadStatus}</div>}

      <div className="controls">
        <input
          type="text"
          placeholder="Filter by zeolite name…"
          value={pendingName}
          onChange={(e) => setPendingName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') setNameQuery(pendingName.trim()); }}
          disabled={loading}
        />
        <button onClick={() => setNameQuery(pendingName.trim())}>Search</button>
        
        <select
          value={targetFilter}
          onChange={(e) => setTargetFilter(e.target.value)}
          disabled={loading}
        >
          <option value="">All Targets</option>
          {uniqueTargets.map(target => (
            <option key={target} value={target}>{target}</option>
          ))}
        </select>
        
        <select
          value={predictionFilter}
          onChange={(e) => setPredictionFilter(e.target.value)}
          disabled={loading}
        >
          <option value="">All Predictions</option>
          {uniquePredictions.map(prediction => (
            <option key={prediction} value={prediction}>{prediction}</option>
          ))}
        </select>
        
        <select
          value={applicationFilter}
          onChange={handleApplicationFilterChange}
          disabled={loading}
          className="application-filter"
        >
          <option value="">All Zeolites</option>
          {applicationFiles.map(app => (
            <option key={app.value} value={app.value}>{app.label}</option>
          ))}
        </select>
        
        <div className="file-upload-container">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
            id="csv-upload"
          />
          <label htmlFor="csv-upload" className="upload-button">
            📁 Upload CSV Filter
          </label>
          {uploadedFileName && (
            <div className="uploaded-file-info">
              <span className="filename">{uploadedFileName}</span>
              <button 
                onClick={clearUploadedFilter}
                className="clear-upload"
                title="Clear uploaded filter"
              >
                ✕
              </button>
            </div>
          )}
        </div>
        
        <button 
          onClick={exportFilteredResults}
          disabled={loading || index.length === 0}
          className="export-button"
        >
          📊 Export CSV
        </button>
        
        <button onClick={() => { 
          setPendingName(""); 
          setNameQuery(""); 
          setTargetFilter(""); 
          setPredictionFilter(""); 
          setApplicationFilter("");
          setApplicationZeolites(new Set());
          setApplicationData([]);
          setApplicationColumns([]);
          clearUploadedFilter();
        }}>Clear All</button>
      </div>

      <div className="table-container">
        <div className="table" ref={containerRef}>
          <table className="grid">
            <colgroup>
              {allColumnWidths.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {allColumns.map((c) => (
                  <th key={c.id} onClick={() => requestSort(c.id)} className={`sortable ${c.isUploaded ? 'uploaded-column' : ''} ${c.isApplication ? 'application-column' : ''}`}>
                    {c.header}{sort.col === c.id ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Top spacer row to push visible rows */}
              <tr className="spacer" style={{ height: (virtualRows[0]?.start ?? 0) }}>
                <td colSpan={allColumns.length} />
              </tr>

              {/* Visible rows */}
              {index.length === 0 ? (
                <tr className="row">
                  <td colSpan={allColumns.length} style={{ padding: 12, color: '#9db1c9' }}>
                    {uploadedZeolites.size > 0 
                      ? `No zeolites found matching the uploaded filter (${uploadedZeolites.size} zeolites in filter).`
                      : applicationZeolites.size > 0
                      ? `No zeolites found matching the application filter (${applicationZeolites.size} zeolites in filter).`
                      : 'No matching zeolites.'
                    }
                  </td>
                </tr>
              ) : (
                <>
                  {virtualRows.map((vr) => {
                    const i = index[vr.index];
                    const zeoliteName = dataCols?.Z[i];
                    
                    // Find matching uploaded data
                    const uploadedRow = uploadedData.find(row => {
                      const zeoliteCol = Object.keys(row).find(key => 
                        /^(zeolite|zeolites|name|structure)$/i.test(key) || /zeolite/i.test(key)
                      );
                      return zeoliteCol ? row[zeoliteCol] === zeoliteName : false;
                    });
                    
                    // Find matching application data
                    const applicationRow = applicationData.find(row => {
                      const zeoliteCol = Object.keys(row).find(key => 
                        /^(zeolite|zeolites|name|structure)$/i.test(key) || /zeolite/i.test(key)
                      );
                      return zeoliteCol ? row[zeoliteCol] === zeoliteName : false;
                    });
                    
                    return (
                      <tr key={i} className="row">
                        <td>{columns[0].fmt(dataCols?.Z[i])}</td>
                        <td>{columns[1].fmt(dataCols?.T[i])}</td>
                        <td>{columns[2].fmt(dataCols?.Pred[i])}</td>
                        <td className="num">{columns[3].fmt(dataCols?.PSi[i])}</td>
                        <td className="num">{columns[4].fmt(dataCols?.PP[i])}</td>
                        <td className="num">{columns[5].fmt(dataCols?.PSIP[i])}</td>
                        <td className="num">{columns[6].fmt(dataCols?.PPCOD[i])}</td>
                        {uploadedColumns.map(col => (
                          <td key={col.id} className={col.numeric ? 'num' : ''}>
                            {formatUploadedValue(uploadedRow ? uploadedRow[col.id] : null)}
                          </td>
                        ))}
                        {applicationColumns.map(col => (
                          <td key={col.id} className={col.numeric ? 'num application-data' : 'application-data'}>
                            {formatUploadedValue(applicationRow ? applicationRow[col.id] : null)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </>
              )}

              {/* Bottom spacer row to fill remaining space */}
              <tr className="spacer" style={{ height: Math.max(0, totalSize - ((virtualRows[virtualRows.length-1]?.end) ?? 0)) }}>
                <td colSpan={allColumns.length} />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <Style />
    </div>
  );
}

// Helpers
function getCol(dc, colId){
  switch (colId) {
    case 'zeolite': return dc.Z;
    case 'target': return dc.T;
    case 'prediction': return dc.Pred;
    case 'prob_Si': return dc.PSi;
    case 'Prob_P': return dc.PP;
    case 'prob_Si/P': return dc.PSIP;
    case 'prob_PCOD': return dc.PPCOD;
    default: return [];
  }
}
function cmp(a,b){
  const na = a == null || a === ''; const nb = b == null || b === '';
  if (na && nb) return 0; if (na) return 1; if (nb) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
function num(v){ if (v==null||v==='') return ''; const n=Number(v); return Number.isInteger(n)? n : Number(n).toFixed(2); }
function toNum(v){ const n=Number(v); return Number.isFinite(n)? n : null; }

// Format uploaded values properly for display
function formatUploadedValue(v) {
  if (v == null || v === '') return '';
  
  // Convert to number if possible
  const numValue = Number(v);
  if (!isNaN(numValue) && isFinite(numValue)) {
    // Handle very small numbers (scientific notation)
    if (Math.abs(numValue) < 0.001 && numValue !== 0) {
      return numValue.toExponential(3);
    }
    // Handle integers
    if (Number.isInteger(numValue)) {
      return numValue.toString();
    }
    // Handle regular decimals
    return numValue.toFixed(3);
  }
  
  // Return as string for non-numeric values
  return String(v);
}

function Style() {
  return (
    <style>{`
      :root{ --bg:#0b1015; --card:#0f1620; --muted:#9db1c9; --text:#eaf2fb; --acc:#5fb3ff; --app:#28a745; }
      *{ box-sizing: border-box; }
      body{ margin:0; background:var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
      .wrap{ max-width: 1400px; margin: 24px auto; padding: 16px; }
      h1{ font-size: 18px; margin: 0 0 12px; }
      .status{ margin-bottom: 8px; font-size: 12px; color: var(--muted); }
      .upload-status{ margin-bottom: 8px; font-size: 12px; color: var(--acc); }
      .controls{ display:flex; gap:8px; margin: 8px 0 12px; flex-wrap: wrap; align-items: center; }
      input[type="text"], select{ background: var(--card); color: var(--text); border: 1px solid #1f2a36; padding: 8px 10px; border-radius: 8px; }
      select.application-filter{ border-color: var(--app); }
      button{ background: var(--card); color: var(--text); border: 1px solid #1f2a36; padding: 8px 12px; border-radius: 8px; cursor: pointer; }
      button:hover{ background: #1a2430; }
      button:disabled{ opacity: 0.5; cursor: not-allowed; }
      
      .file-upload-container{ display: flex; align-items: center; gap: 8px; }
      .upload-button{ 
        background: var(--acc); 
        color: white; 
        border: none; 
        padding: 8px 12px; 
        border-radius: 8px; 
        cursor: pointer; 
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .upload-button:hover{ background: #4a9fe7; }
      
      .export-button{
        background: #28a745;
        color: white;
        border: none;
        padding: 8px 12px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .export-button:hover{ background: #218838; }
      .export-button:disabled{ background: #6c757d; cursor: not-allowed; }
      
      .uploaded-file-info{ 
        display: flex; 
        align-items: center; 
        gap: 4px; 
        background: var(--card); 
        padding: 4px 8px; 
        border-radius: 6px; 
        border: 1px solid #1f2a36;
      }
      .filename{ font-size: 12px; color: var(--muted); }
      .clear-upload{ 
        background: none; 
        border: none; 
        color: var(--muted); 
        cursor: pointer; 
        padding: 2px 4px; 
        font-size: 12px;
        line-height: 1;
      }
      .clear-upload:hover{ color: var(--text); }
      
      .table-container{ 
        width: 100%; 
        overflow-x: auto; 
        border: 1px solid #1f2a36; 
        border-radius: 10px; 
        background: var(--card);
      }
      
      .table{ 
        height: 70vh; 
        overflow: auto; 
        min-width: 100%;
      }

      table.grid{ 
        width: max-content; 
        min-width: 100%;
        border-collapse: collapse; 
        table-layout: fixed; 
      }
      thead th{ 
        position: sticky; 
        top:0; 
        background:#111a24; 
        text-align:left; 
        padding: 8px; 
        height: 36px; 
        border-bottom:1px solid #1e2a36; 
        font-size: 12px;
      }
      thead th.uploaded-column{ background: #1a2d3a; border-left: 2px solid var(--acc); }
      thead th.application-column{ background: #1a3d2a; border-left: 2px solid var(--app); }
      .sortable{ cursor: pointer; user-select: none; }
      tbody td{ 
        padding: 6px 8px; 
        border-bottom: 1px solid #1a2430; 
        font-size: 11px;
      }
      tbody td.num{ text-align: right; }
      tbody td.application-data{ background: rgba(40, 167, 69, 0.1); }
      tr.row:hover{ background:#121b26; }
      thead th, tbody td{ 
        overflow: hidden; 
        text-overflow: ellipsis; 
        white-space: nowrap; 
      }
      
      /* Responsive adjustments */
      @media (max-width: 1200px) {
        .wrap{ max-width: 100%; padding: 12px; }
        .controls{ flex-direction: column; align-items: stretch; }
        .controls > * { margin-bottom: 4px; }
      }
    `}</style>
  );
}
