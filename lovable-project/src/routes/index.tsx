import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  RefreshCw,
  Database,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Clock,
  Settings,
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
import {
  greeting,
  recentActivity,
  timelineOptions,
  workbookSheets,
  type Timeline,
} from "@/lib/sync-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sync Dashboard — VNC Cin7 Integration Platform" },
      {
        name: "description",
        content:
          "Sync live Cin7 Core sales, inventory and purchase data into your master financial model in one click.",
      },
      { property: "og:title", content: "Sync Dashboard — VNC Cin7 Integration Platform" },
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
  const [timeline, setTimeline] = useState<Timeline>("30d");
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState("Today at 8:04 AM");
  const [hello, setHello] = useState("Good morning");

  useEffect(() => setHello(greeting()), []);

  const label = timelineOptions.find((t) => t.value === timeline)?.label ?? "";
  const onComplete = useCallback(() => {
    setLastSync(
      "Today at " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-hero-gradient text-navy-foreground">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-white/15 text-sm font-bold">
              VNC
            </span>
            <span className="text-sm font-medium opacity-90">Cin7 Sync</span>
          </div>
          <Button asChild variant="secondary" size="sm">
            <Link to="/settings">
              <Settings className="size-4" /> Settings
            </Link>
          </Button>
        </div>
        <div className="mx-auto max-w-6xl px-6 pb-12">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{hello} 👋</h1>
          <p className="mt-2 text-sm opacity-80">
            Keep your data in sync. Last sync {lastSync.toLowerCase()}.
          </p>
        </div>
      </header>

      <main className="mx-auto -mt-8 max-w-6xl space-y-6 px-6 pb-16">
        <div className="grid gap-4 sm:grid-cols-2">
          <StatusCard
            icon={<Database className="size-5" />}
            title="Cin7 Core ERP"
            subtitle="Connected · VNC Global Trading"
            state="ok"
          />
          <StatusCard
            icon={<FileSpreadsheet className="size-5" />}
            title="Spreadsheet destination"
            subtitle="Controller Reporting Model v5 · 17 sheets"
            state="ok"
          />
        </div>

        <Card className="overflow-hidden border-0 shadow-lift">
          <div className="bg-sync-gradient px-6 py-6 text-primary-foreground sm:px-8">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold">Sync your data</h2>
                <p className="mt-1 text-sm opacity-85">
                  Pull sales, inventory and purchase orders into your model.
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
                  className="font-semibold"
                  onClick={() => setSyncing(true)}
                >
                  <RefreshCw className="size-4" /> Sync now
                </Button>
              </div>
            </div>
          </div>
          <CardContent className="grid gap-4 pt-6 sm:grid-cols-3">
            <Metric value="1,248" label="Records today" />
            <Metric value="1,230" label="Successfully synced" tone="success" />
            <Metric value="18" label="Need attention" tone="warning" />
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Recent activity</CardTitle>
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
                      <CheckCircle2 className="size-4 text-success" />
                    ) : (
                      <AlertTriangle className="size-4 text-warning" />
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
              <CardTitle className="text-base">Your financial model</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {workbookSheets.map((s) => (
                  <li key={s} className="flex items-center gap-2 text-muted-foreground">
                    <FileSpreadsheet className="size-4 shrink-0 text-primary" />
                    <span className="truncate text-foreground">{s}</span>
                  </li>
                ))}
              </ul>
              <Button variant="outline" className="mt-4 w-full">
                Open workbook <ArrowRight className="size-4" />
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
    </div>
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
            state === "ok" ? "bg-success/15 text-success" : "bg-warning/20 text-warning",
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
  tone,
}: {
  value: string;
  label: string;
  tone?: "success" | "warning";
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <p
        className={cn(
          "text-2xl font-semibold tabular-nums",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
