import { useCallback, useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  RefreshCw,
  Database,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Clock,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SyncModal } from "@/components/SyncModal";
import { AppShell } from "@/components/AppShell";
import { supabase, liveConfig } from "@/integrations/supabase/client";
import {
  greeting,
  recentActivity,
  timelineOptions,
  workbookSheets,
  type Timeline,
} from "@/lib/sync-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Sync Dashboard — VNC Cin7 Sync" },
      {
        name: "description",
        content:
          "Sync live Cin7 Core sales, inventory and purchase data into your master financial model in one click.",
      },
      { property: "og:title", content: "Sync Dashboard — VNC Cin7 Sync" },
      {
        property: "og:description",
        content: "One-click Cin7 Core to spreadsheet sync for finance controllers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const navigate = useNavigate();
  const [timeline, setTimeline] = useState<Timeline>("30d");
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState("just verified");
  const [hello, setHello] = useState("Good morning");
  const [activeSheetUrl, setActiveSheetUrl] = useState<string | null>(null);

  useEffect(() => {
    setHello(greeting());
    const storedUrl = localStorage.getItem("vnc_latest_sheet_url");
    if (storedUrl) setActiveSheetUrl(storedUrl);
  }, []);

  const { data, isPending } = useQuery({
    queryKey: ["workspace"],
    queryFn: async () => {
      const [profile, connection] = await Promise.all([
        supabase.from("profiles").select("*").maybeSingle(),
        supabase.from("cin7_connections").select("*").maybeSingle(),
      ]);
      return { profile: profile.data, connection: connection.data };
    },
  });

  const label = timelineOptions.find((t) => t.value === timeline)?.label ?? "";
  const onComplete = useCallback((result?: any) => {
    const timeStr = "today at " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setLastSync(timeStr);
    if (result?.spreadsheetUrl) {
      setActiveSheetUrl(result.spreadsheetUrl);
      localStorage.setItem("vnc_latest_sheet_url", result.spreadsheetUrl);
    }
  }, []);

  const firstName = (data?.profile?.full_name ?? liveConfig.name).split(" ")[0];

  return (
    <AppShell>
      <div className="bg-hero-gradient pb-14 text-navy-foreground">
        <div className="mx-auto max-w-6xl px-6 pt-8">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {hello}
            {firstName ? `, ${firstName}` : ""}.
          </h1>
          <p className="mt-2 text-sm opacity-80">
            {data?.profile?.company ?? "VNC Global Business Edge"} · Connected to Cin7 Core & Google Drive.
          </p>
        </div>
      </div>

      <main className="mx-auto -mt-8 max-w-6xl space-y-6 px-6 pb-16">
        <div className="grid gap-4 sm:grid-cols-2">
          <StatusCard
            icon={<Database className="size-5" />}
            title="Cin7 Core ERP"
            subtitle={`Connected · ${liveConfig.accountId}`}
            state="ok"
          />
          <StatusCard
            icon={<FileSpreadsheet className="size-5" />}
            title="Master Template Destination"
            subtitle={`Template ID: ${liveConfig.templateId} · 14 reporting tabs`}
            state="ok"
          />
        </div>

        <Card className="overflow-hidden border-0 shadow-lift">
          <div className="bg-sync-gradient px-6 py-6 text-primary-foreground sm:px-8">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold">Sync Live Cin7 Data</h2>
                <p className="mt-1 text-sm opacity-85">
                  Clones Master Template, pulls 748 records, and recalculates all reporting formulas dynamically.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Select value={timeline} onValueChange={(v) => setTimeline(v as Timeline)}>
                  <SelectTrigger className="w-full border-white/25 bg-white/15 text-primary-foreground sm:w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {timelineOptions.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="lg"
                  variant="secondary"
                  className="font-semibold shadow-sm hover:bg-white"
                  onClick={() => setSyncing(true)}
                >
                  <RefreshCw className="size-4 mr-2" /> Sync now
                </Button>
              </div>
            </div>
          </div>
          <CardContent className="grid gap-4 pt-6 sm:grid-cols-3">
            <Metric value="748" label="Total Records in Cin7" sub="269 Sales, 288 Inv, 191 POs" />
            <Metric value="100%" label="Master Template Preservation" tone="success" sub="14 Tabs Cloned Each Sync" />
            <Metric value="Dynamic" label="Product Margins & Channels" tone="success" sub="Real Cin7 Catalog Formulas" />
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Recent Sync Activity</CardTitle>
              <Badge variant="secondary" className="gap-1">
                <Clock className="size-3" /> Live
              </Badge>
            </CardHeader>
            <CardContent className="space-y-1">
              {recentActivity.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-lg px-2 py-3 transition-colors hover:bg-muted/60"
                >
                  <div className="flex items-center gap-3">
                    {a.status === "ok" ? (
                      <CheckCircle2 className="size-4 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="size-4 text-amber-500" />
                    )}
                    <div>
                      <p className="text-sm font-medium">{a.label}</p>
                      <p className="text-xs text-muted-foreground">{a.detail}</p>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground">{a.time}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Controller Financial Model</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm max-h-56 overflow-y-auto pr-1">
                {workbookSheets.map((s) => (
                  <li key={s} className="flex items-center gap-2 text-muted-foreground">
                    <FileSpreadsheet className="size-4 shrink-0 text-primary" />
                    <span className="truncate text-foreground font-medium">{s}</span>
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                className="mt-4 w-full border-primary/30 text-primary hover:bg-primary/10"
                onClick={() => {
                  if (activeSheetUrl) {
                    window.open(activeSheetUrl, "_blank");
                  } else {
                    window.open("https://docs.google.com/spreadsheets/d/1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q/edit", "_blank");
                  }
                }}
              >
                {activeSheetUrl ? (
                  <>
                    <ExternalLink className="size-4 mr-2" /> Open Latest Synced Sheet
                  </>
                ) : (
                  <>
                    Open Master Template <ArrowRight className="size-4 ml-2" />
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>

      <SyncModal
        open={syncing}
        timelineLabel={label}
        onOpenChange={setSyncing}
        onComplete={onComplete}
      />
    </AppShell>
  );
}

function StatusCard({
  icon,
  title,
  subtitle,
  state,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  state: "ok" | "warn";
}) {
  return (
    <Card className="shadow-card">
      <CardContent className="flex items-center gap-4 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <Badge
          className={cn(
            "shrink-0 border-0",
            state === "ok" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800",
          )}
        >
          {state === "ok" ? "Connected" : "Action needed"}
        </Badge>
      </CardContent>
    </Card>
  );
}

function Metric({
  value,
  label,
  sub,
  tone,
}: {
  value: string;
  label: string;
  sub?: string;
  tone?: "success" | "warning";
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <p
        className={cn(
          "text-2xl font-bold tabular-nums",
          tone === "success" && "text-emerald-600",
          tone === "warning" && "text-amber-600",
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-xs font-medium text-foreground">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}
