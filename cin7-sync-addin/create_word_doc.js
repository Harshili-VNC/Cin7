const fs = require("fs");
const path = require("path");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  ImageRun,
  ShadingType
} = require("docx");

const artifactDir = "C:\\Users\\Harshili Patni\\.gemini\\antigravity-ide\\brain\\594e86ce-38b6-4040-9d2b-58b327acea26";
const dashboardImgPath = path.join(artifactDir, "cin7_excel_dashboard_ui_1786353533458.png");
const auditImgPath = path.join(artifactDir, "cin7_sync_log_audit_ui_1786353552127.png");

const dashboardImg = fs.existsSync(dashboardImgPath) ? fs.readFileSync(dashboardImgPath) : null;
const auditImg = fs.existsSync(auditImgPath) ? fs.readFileSync(auditImgPath) : null;

const createHeaderCell = (text, widthPct = 25) => new TableCell({
  width: { size: widthPct, type: WidthType.PERCENTAGE },
  shading: { fill: "1E293B", type: ShadingType.CLEAR },
  children: [new Paragraph({
    children: [new TextRun({ text, bold: true, color: "FFFFFF", font: "Segoe UI", size: 20 })]
  })]
});

const createBodyCell = (text, widthPct = 25, bold = false) => new TableCell({
  width: { size: widthPct, type: WidthType.PERCENTAGE },
  children: [new Paragraph({
    children: [new TextRun({ text, bold, font: "Segoe UI", size: 19, color: "334155" })]
  })]
});

const doc = new Document({
  sections: [
    {
      properties: {},
      children: [
        // Title
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200, before: 200 },
          children: [
            new TextRun({
              text: "⚡ CIN7 SYNC ENGINE",
              bold: true,
              size: 44,
              color: "0F6CBD",
              font: "Segoe UI"
            })
          ]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 },
          children: [
            new TextRun({
              text: "Commercial Enterprise Reporting Application for Microsoft Excel",
              italic: true,
              size: 24,
              color: "475569",
              font: "Segoe UI"
            })
          ]
        }),

        // Executive Summary
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 300, after: 150 },
          children: [new TextRun({ text: "1. Executive Summary", bold: true, size: 28, color: "0F172A", font: "Segoe UI" })]
        }),
        new Paragraph({
          spacing: { after: 200 },
          children: [
            new TextRun({
              text: "The Cin7 Sync Engine is a 1-click automated reporting application embedded inside Microsoft Excel. It connects Excel directly to a backend Sync Engine REST API (running at http://localhost:8000), pulls live Sales, Inventory, and Purchase Order data from Cin7 ERP, auto-formats the sheets with visual KPI summary banners, and maintains an automated compliance audit log.",
              size: 22,
              font: "Segoe UI",
              color: "334155"
            })
          ]
        }),

        // Workflow Steps Table
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 250, after: 150 },
          children: [new TextRun({ text: "End-to-End Execution Workflow", bold: true, size: 24, color: "0F6CBD", font: "Segoe UI" })]
        }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                createHeaderCell("Stage", 20),
                createHeaderCell("Process Step", 30),
                createHeaderCell("Technical Execution Details", 50)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("Stage 1", 20, true),
                createBodyCell("User Selection in Excel", 30, true),
                createBodyCell("User picks timeline (e.g. 'Last 30 days') from cell B3 dropdown and clicks 'Run Sync'.", 50)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("Stage 2", 20, true),
                createBodyCell("Canvas Prep & Audit Log", 30, true),
                createBodyCell("Hides gridlines, formats application shell header, and creates a 'Running' entry on the Sync Log sheet.", 50)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("Stage 3", 20, true),
                createBodyCell("Secure Server Request", 30, true),
                createBodyCell("Sends HTTP POST request to backend API (http://localhost:8000) with x-api-key & Client ID headers.", 50)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("Stage 4", 20, true),
                createBodyCell("Cin7 ERP Ingestion", 30, true),
                createBodyCell("Backend server authenticates with Cin7 API, handles rate limits, batch pagination, and pulls fresh data.", 50)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("Stage 5", 20, true),
                createBodyCell("Auto-Formatting & KPIs", 30, true),
                createBodyCell("Populates Sales, Inventory & Purchase sheets, applies zebra striping, currency ($), and builds top KPI banners.", 50)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("Stage 6", 20, true),
                createBodyCell("Audit Settlement", 30, true),
                createBodyCell("Updates Sync Log status to 'Success' with total row count and timestamp, displaying green status bar.", 50)
              ]
            })
          ]
        }),

        // Dashboard Screenshot
        ...(dashboardImg ? [
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 300, after: 150 },
            children: [new TextRun({ text: "2. Enterprise Excel Reporting Interface", bold: true, size: 24, color: "0F6CBD", font: "Segoe UI" })]
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [
              new ImageRun({
                data: dashboardImg,
                transformation: { width: 550, height: 310 }
              })
            ]
          })
        ] : []),

        // Cin7 API Request Management
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 300, after: 150 },
          children: [new TextRun({ text: "3. Cin7 ERP Request Management & Architecture", bold: true, size: 28, color: "0F172A", font: "Segoe UI" })]
        }),
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({ text: "Secure Authentication: ", bold: true, font: "Segoe UI" }),
            new TextRun({ text: "Backend injects Cin7 API keys (api-auth-cn and api-auth-key) securely on server-side without exposing credentials in client scripts.", font: "Segoe UI" })
          ]
        }),
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({ text: "Rate Limit Management: ", bold: true, font: "Segoe UI" }),
            new TextRun({ text: "Manages outgoing requests using a queue buffer to strictly respect Cin7's API limit (max 60 requests/minute).", font: "Segoe UI" })
          ]
        }),
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({ text: "Pagination & Batch Ingestion: ", bold: true, font: "Segoe UI" }),
            new TextRun({ text: "Fetches large datasets in 250-record page batches using $skip and $top to prevent memory spikes and timeouts.", font: "Segoe UI" })
          ]
        }),
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({ text: "Delta Filtering (updated_since): ", bold: true, font: "Segoe UI" }),
            new TextRun({ text: "Converts selected Excel timeline into Cin7 API filters (e.g. ModifiedDate > '2026-07-11'), downloading only modified records.", font: "Segoe UI" })
          ]
        }),
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({ text: "Exponential Backoff Retry: ", bold: true, font: "Segoe UI" }),
            new TextRun({ text: "Automatically catches temporary HTTP 429 / 503 responses and retries after exponential delays (2s, 4s, 8s).", font: "Segoe UI" })
          ]
        }),

        // Audit Log Screenshot
        ...(auditImg ? [
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 300, after: 150 },
            children: [new TextRun({ text: "4. Automated Audit Log & Compliance Sheet", bold: true, size: 24, color: "0F6CBD", font: "Segoe UI" })]
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [
              new ImageRun({
                data: auditImg,
                transformation: { width: 550, height: 280 }
              })
            ]
          })
        ] : []),

        // Deployment & Financial Costs Table
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 300, after: 150 },
          children: [new TextRun({ text: "5. Financial & Infrastructure Cost Breakdown", bold: true, size: 28, color: "0F172A", font: "Segoe UI" })]
        }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                createHeaderCell("Cost Component", 35),
                createHeaderCell("Local Sync Server Infrastructure", 65)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("Excel Data Storage", 35, true),
                createBodyCell("$0.00 (Included in existing M365 OneDrive/SharePoint storage)", 65)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("API Compute Hosting", 35, true),
                createBodyCell("$0.00 (Runs on existing internal office server/hardware)", 65)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("Network Data Transfer", 35, true),
                createBodyCell("$0.00 (Internal local network connectivity)", 65)
              ]
            }),
            new TableRow({
              children: [
                createBodyCell("Total Monthly Cost", 35, true),
                createBodyCell("$0.00 / month (Zero extra cloud or server costs)", 65, true)
              ]
            })
          ]
        })
      ]
    }
  ]
});

Packer.toBuffer(doc).then((buffer) => {
  const outputPath = path.join(__dirname, "Cin7_Sync_Engine_Executive_Documentation.docx");
  fs.writeFileSync(outputPath, buffer);
  console.log("Successfully generated Word .docx document at:", outputPath);
});
