import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut, LayoutDashboard, Settings, Menu, X, KeyRound, ExternalLink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { VncLockup } from "@/components/VncLogo";

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-hero-gradient text-navy-foreground shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 sm:px-6 py-3">
          <Link to="/dashboard" className="flex items-center gap-2">
            <VncLockup />
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-2">
            <NavLink to="/dashboard" icon={<LayoutDashboard className="size-4" />} label="Sync Dashboard" />
            <NavLink to="/settings" icon={<Settings className="size-4" />} label="Settings & Keys" />
            <Button
              variant="ghost"
              size="sm"
              onClick={signOut}
              className="text-navy-foreground hover:bg-white/10 hover:text-navy-foreground text-xs font-medium"
            >
              <LogOut className="size-4 mr-1.5" />
              <span>Sign out</span>
            </Button>
          </nav>

          {/* Mobile Menu Button */}
          <div className="flex items-center gap-2 md:hidden">
            <Button
              variant="ghost"
              size="sm"
              className="text-navy-foreground p-2 hover:bg-white/10"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle Navigation Menu"
            >
              {mobileMenuOpen ? <X className="size-6" /> : <Menu className="size-6" />}
            </Button>
          </div>
        </div>

        {/* Mobile Dropdown Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-white/10 bg-[#0F172A] px-4 py-4 space-y-2 animate-in slide-in-from-top duration-200">
            <Link
              to="/dashboard"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white hover:bg-white/10"
            >
              <LayoutDashboard className="size-4 text-emerald-400" />
              Sync Dashboard
            </Link>
            <Link
              to="/settings"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white hover:bg-white/10"
            >
              <Settings className="size-4 text-emerald-400" />
              Settings & Credentials
            </Link>
            <Link
              to="/auth"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white hover:bg-white/10"
            >
              <KeyRound className="size-4 text-emerald-400" />
              Authentication & Login
            </Link>
            <div className="pt-2 border-t border-white/10">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setMobileMenuOpen(false);
                  signOut();
                }}
                className="w-full justify-start text-xs font-medium"
              >
                <LogOut className="size-4 mr-2" />
                Sign out
              </Button>
            </div>
          </div>
        )}
      </header>
      <div className="flex-1 w-full">
        {children}
      </div>
    </div>
  );
}

function NavLink({
  to,
  icon,
  label,
}: {
  to: "/dashboard" | "/settings";
  icon: ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium opacity-85 transition-colors hover:bg-white/10 hover:opacity-100"
      activeProps={{ className: "bg-white/15 opacity-100 font-semibold" }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
