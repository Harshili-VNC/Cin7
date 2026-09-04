import badge from "@/assets/vnc-badge.png.asset.json";
import wordmark from "@/assets/vnc-wordmark.png.asset.json";
import { cn } from "@/lib/utils";

export function VncBadge({ className }: { className?: string }) {
  return (
    <img
      src={badge.url}
      alt="VNC Global"
      className={cn("size-9 rounded-full object-contain", className)}
    />
  );
}

export function VncWordmark({ className }: { className?: string }) {
  return (
    <img src={wordmark.url} alt="VNC Global" className={cn("h-10 object-contain", className)} />
  );
}

export function VncLockup({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <VncBadge className="size-9 ring-1 ring-white/25" />
      <div className="leading-tight">
        <p className="text-sm font-semibold tracking-wide">VNC GLOBAL</p>
        <p className="text-[11px] uppercase tracking-[0.18em] opacity-70">Cin7 Sync</p>
      </div>
    </div>
  );
}
