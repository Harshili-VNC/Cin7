export type Timeline = "7d" | "30d" | "90d" | "365d" | "month" | "quarter" | "ytd" | "all";

export const timelineOptions: { value: Timeline; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "365d", label: "Last 365 days" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "ytd", label: "Year to date" },
  { value: "all", label: "All time (Full Sync)" },
];

export const syncStages = [
  "Connecting to Cin7 Core API",
  "Fetching live Sales (269), Inventory (288), POs (191)",
  "Cloning Master Template (1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q)",
  "Injecting 748 records into Raw Data tabs",
  "Calculating dynamic KPIs & Catalog metrics",
  "Granting viewer permissions to harshili.patni@vnc.global",
  "Sync verified & complete"
] as const;

export type ActivityItem = {
  id: string;
  label: string;
  detail: string;
  time: string;
  status: "ok" | "warn" | "error";
};

export const recentActivity: ActivityItem[] = [
  {
    id: "1",
    label: "Google Sheets Sync",
    detail: "748 records cloned into fresh sheet",
    time: "Just now",
    status: "ok",
  },
  {
    id: "2",
    label: "Sales Transactions",
    detail: "269 orders synced & mapped to catalog",
    time: "Today",
    status: "ok",
  },
  {
    id: "3",
    label: "Inventory on Hand",
    detail: "288 SKUs & stock levels verified",
    time: "Today",
    status: "ok",
  },
  {
    id: "4",
    label: "Purchase Orders",
    detail: "191 POs & cost inputs calculated",
    time: "Today",
    status: "ok",
  },
];

export const workbookSheets = [
  "📋 Cover & Index",
  "KPI Dashboard",
  "Weekly Order Tracker",
  "Sales Trend Analysis",
  "Product Margin Analysis",
  "COGS & Profitability by Channel",
  "Inventory & MOS Analysis",
  "Inventory Movements",
  "Profitability Dashboard",
  "Sales Dashboard",
  "Sales Transactions Raw Data",
  "Inventory On Hand Raw Data",
  "Purchase Transactions Raw data",
  "Cost Inputs",
];

export const attentionItems = [
  { sku: "4TB115-P", issue: "Top Margin Item", suggestion: "Revenue $25,201 | 45.0% Gross Margin" },
  { sku: "L1001140409", issue: "High Volume", suggestion: "Revenue $22,000 | 45.0% Gross Margin" },
  { sku: "9CS22-B", issue: "Top Velocity", suggestion: "Revenue $17,527 | 45.0% Gross Margin" },
];

export function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
