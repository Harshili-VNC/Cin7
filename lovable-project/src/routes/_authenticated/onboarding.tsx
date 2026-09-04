import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Check, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VncBadge } from "@/components/VncLogo";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [
      { title: "Connect Cin7 Core — VNC Cin7 Sync" },
      {
        name: "description",
        content:
          "Connect your Cin7 Core account ID and API key so VNC can sync your ERP data into your master model.",
      },
      { property: "og:title", content: "Connect Cin7 Core — VNC Cin7 Sync" },
      { property: "og:description", content: "Two-minute setup for your ERP sync." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Onboarding,
});

const schema = z.object({
  accountId: z.string().trim().min(4, "Enter your Cin7 Account ID").max(120),
  apiKey: z.string().trim().min(8, "Enter your Cin7 API key").max(300),
  destination: z.string().trim().min(2).max(160),
  billingType: z.string().min(2),
  subscriptionKey: z.string().trim().max(120).optional(),
});

function Onboarding() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [billingType, setBillingType] = useState("trial");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const parsed = schema.safeParse({
      accountId: form.get("accountId"),
      apiKey: form.get("apiKey"),
      destination: form.get("destination"),
      billingType,
      subscriptionKey: form.get("subscriptionKey") ?? "",
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]!.message);
      return;
    }

    setBusy(true);
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      setBusy(false);
      toast.error("Session expired. Please sign in again.");
      return;
    }

    const { error: connError } = await supabase.from("cin7_connections").upsert(
      {
        user_id: userId,
        account_id: parsed.data.accountId,
        api_key: parsed.data.apiKey,
        destination: parsed.data.destination,
      },
      { onConflict: "user_id" },
    );
    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        billing_type: parsed.data.billingType,
        subscription_key: parsed.data.subscriptionKey || null,
        onboarded: true,
      })
      .eq("id", userId);

    setBusy(false);
    if (connError || profileError) {
      toast.error(connError?.message ?? profileError?.message ?? "Could not save");
      return;
    }
    toast.success("Cin7 Core connected");
    navigate({ to: "/dashboard", replace: true });
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-hero-gradient pb-20 text-navy-foreground">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-6">
          <VncBadge className="ring-1 ring-white/25" />
          <span className="text-sm font-medium opacity-90">Set up your workspace</span>
        </div>
        <div className="mx-auto max-w-3xl px-6">
          <h1 className="text-3xl font-semibold tracking-tight">Connect Cin7 Core</h1>
          <p className="mt-2 max-w-xl text-sm opacity-80">
            We use your Account ID and API key to read sales, inventory and purchase data. Nothing
            is ever written back to your ERP.
          </p>
        </div>
      </div>

      <main className="mx-auto -mt-12 max-w-3xl px-6 pb-16">
        <form
          onSubmit={onSubmit}
          className="space-y-5 rounded-2xl border bg-card p-6 shadow-lift sm:p-8"
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="accountId">Cin7 Core Account ID</Label>
              <Input id="accountId" name="accountId" placeholder="a1b2c3d4-...." />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apiKey">Cin7 Core API key</Label>
              <Input id="apiKey" name="apiKey" type="password" placeholder="••••••••••••" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="destination">Spreadsheet destination</Label>
            <Input
              id="destination"
              name="destination"
              defaultValue="Controller Reporting Master Template"
            />
            <p className="text-xs text-muted-foreground">
              The 17-worksheet master model we populate on every sync.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Billing type</Label>
              <Select value={billingType} onValueChange={setBillingType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">Free trial</SelectItem>
                  <SelectItem value="monthly">Monthly subscription</SelectItem>
                  <SelectItem value="annual">Annual subscription</SelectItem>
                  <SelectItem value="enterprise">Enterprise agreement</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="subscriptionKey">Subscription key (optional)</Label>
              <Input id="subscriptionKey" name="subscriptionKey" placeholder="VNC-XXXX-XXXX" />
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-accent px-4 py-3 text-sm text-accent-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            Your credentials are stored against your account only and are never shared across
            organisations.
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            Connect and continue
          </Button>
          <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Check className="size-3" /> You can change all of this later in Settings
          </p>
        </form>
      </main>
    </div>
  );
}
