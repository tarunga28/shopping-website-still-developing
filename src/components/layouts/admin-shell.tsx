import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import {
  BarChart3,
  FolderOpen,
  Paintbrush,
  Package,
  Percent,
  Settings,
  ShoppingCart,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * Admin layout shell — dark sidebar + content frame for the back-office
 * surface. Menu structure mirrors the modules of the future admin
 * milestone; items are disabled placeholders until routes exist.
 */

const adminNav: { section: string; items: { label: string; icon: LucideIcon }[] }[] = [
  {
    section: "Operations",
    items: [
      { label: "Orders", icon: ShoppingCart },
      { label: "Products", icon: Package },
      { label: "Designs", icon: Paintbrush },
      { label: "Categories", icon: FolderOpen },
    ],
  },
  {
    section: "Growth",
    items: [
      { label: "Customers", icon: Users },
      { label: "Coupons", icon: Percent },
      { label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    section: "System",
    items: [{ label: "Settings", icon: Settings }],
  },
];

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-svh grid-cols-1 bg-paper lg:grid-cols-[16rem_1fr]">
      <aside className="border-b-[1.5px] border-paper/15 bg-ink text-paper lg:border-b-0 lg:border-r-[1.5px]">
        <div className="border-b border-paper/15 p-5">
          <Logo />
          <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-paper/50">
            Admin console
          </p>
        </div>
        <nav aria-label="Admin" className="space-y-6 p-5">
          {adminNav.map((group) => (
            <div key={group.section}>
              <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-paper/40">
                {group.section}
              </p>
              <ul className="mt-2 space-y-0.5">
                {group.items.map(({ label, icon: Icon }) => (
                  <li key={label}>
                    <span
                      aria-disabled="true"
                      title="Arrives with the admin milestone"
                      className="flex cursor-not-allowed items-center gap-2.5 rounded-card px-3 py-2 text-sm text-paper/50"
                    >
                      <Icon className="size-4" aria-hidden />
                      {label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 p-6 md:p-10">{children}</div>
    </div>
  );
}
