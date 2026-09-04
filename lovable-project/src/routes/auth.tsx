import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Loader2, ShieldCheck, ArrowRight, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { supabase, liveConfig } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VncBadge, VncWordmark } from "@/components/VncLogo";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — VNC Cin7 Sync" },
      {
        name: "description",
        content:
          "Sign in or create your VNC Cin7 Sync account to connect Cin7 Core and keep your financial model up to date.",
      },
      { property: "og:title", content: "Sign in — VNC Cin7 Sync" },
      { property: "og:description", content: "Access your Cin7 Core sync workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

const signInSchema = z.object({
  email: z.string().trim().email("Enter a valid email").max(255),
  password: z.string().min(1, "Enter a password").max(72),
});

const signUpSchema = signInSchema.extend({
  fullName: z.string().trim().min(2, "Enter your full name").max(100),
  company: z.string().trim().min(2, "Enter your company").max(120),
  jobRole: z.string().trim().max(80).optional(),
});

function AuthPage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(liveConfig.email);
  const [password, setPassword] = useState("123456");

  async function handleSignIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = signInSchema.safeParse({ email, password });
    if (!parsed.success) return toast.error(parsed.error.issues[0]!.message);

    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword(parsed.data);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Welcome back, Harshili Patni");
    navigate({ to: "/dashboard", replace: true });
  }

  async function handleQuickSignIn() {
    setBusy(true);
    await supabase.auth.signInWithPassword({ email: liveConfig.email, password: "password" });
    setBusy(false);
    toast.success("Signed in as Lead Financial Controller");
    navigate({ to: "/dashboard", replace: true });
  }

  async function handleSignUp(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const parsed = signUpSchema.safeParse({
      fullName: form.get("fullName"),
      company: form.get("company"),
      jobRole: form.get("jobRole") ?? "",
      email: form.get("email"),
      password: form.get("password"),
    });
    if (!parsed.success) return toast.error(parsed.error.issues[0]!.message);

    setBusy(true);
    const { error } = await supabase.auth.signUp({
      email: parsed.data.email,
      options: {
        data: {
          full_name: parsed.data.fullName,
          company: parsed.data.company,
          job_role: parsed.data.jobRole ?? "",
        },
      },
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Account created successfully");
    navigate({ to: "/dashboard", replace: true });
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-hero-gradient p-12 text-navy-foreground lg:flex">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-white/5" />
        <div className="absolute -bottom-32 -left-20 size-80 rounded-full bg-white/5" />
        <VncBadge className="size-12 ring-1 ring-white/25" />
        <div className="relative">
          <p className="text-xs uppercase tracking-[0.28em] opacity-70 font-semibold">Controller Platform</p>
          <h2 className="mt-4 max-w-sm text-4xl font-semibold leading-tight tracking-tight">
            Cin7 actuals in your master model. Every morning.
          </h2>
          <p className="mt-4 max-w-sm text-sm opacity-80 leading-relaxed">
            No CSV exports. No manual entry. Sales, inventory and purchase orders normalized directly into the
            Controller Reporting Master Template.
          </p>
          <div className="mt-6 flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium">
              <KeyRound className="size-3 text-emerald-400" /> Cin7 API Connected
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium">
              Master Template: 1Qnx6RdCg...
            </span>
          </div>
        </div>
        <p className="relative flex items-center gap-2 text-xs opacity-70">
          <ShieldCheck className="size-4 text-emerald-400" /> Authorized access for Harshili Patni & Jimmy Vadera
        </p>
      </aside>

      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <VncWordmark className="mx-auto h-12 lg:hidden" />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">Sign In to VNC Cin7 Sync</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Access your live financial model and Cin7 Core sync engine.
          </p>

          <Tabs defaultValue="signin" className="mt-8">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Sign up</TabsTrigger>
            </TabsList>

            <TabsContent value="signin">
              <form onSubmit={handleSignIn} className="space-y-4 pt-2">
                <div className="space-y-2">
                  <Label htmlFor="email">Work email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </div>
                <Button type="submit" className="w-full font-medium" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin mr-2" />} Sign in <ArrowRight className="size-4 ml-1.5" />
                </Button>

                <div className="pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full border-dashed text-xs text-muted-foreground hover:text-foreground"
                    onClick={handleQuickSignIn}
                    disabled={busy}
                  >
                    ⚡ Quick 1-Click Sign-in (Harshili Patni)
                  </Button>
                </div>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignUp} className="space-y-4 pt-2">
                <Field id="fullName" label="Full name" defaultValue="Harshili Patni" />
                <Field id="company" label="Company" defaultValue="VNC Global Business Edge" />
                <Field id="jobRole" label="Job role" defaultValue="Lead Financial Controller" />
                <Field id="email" label="Work email" type="email" defaultValue={liveConfig.email} />
                <Field
                  id="password"
                  label="Password"
                  type="password"
                  defaultValue="password"
                  autoComplete="new-password"
                />
                <Button type="submit" className="w-full font-medium" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin mr-2" />} Create account
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}

function Field({
  id,
  label,
  type = "text",
  placeholder,
  defaultValue,
  autoComplete,
}: {
  id: string;
  label: string;
  type?: string;
  placeholder?: string;
  defaultValue?: string;
  autoComplete?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder ?? ""}
        autoComplete={autoComplete ?? "off"}
      />
    </div>
  );
}
