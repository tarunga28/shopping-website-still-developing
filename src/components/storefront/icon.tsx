import {
  Heart,
  Mail,
  Palette,
  Printer,
  Search,
  ShieldCheck,
  ShoppingBag,
  Truck,
  User,
  type LucideIcon,
} from "lucide-react";
import type { StorefrontIcon } from "@/content/storefront";

const icons: Record<StorefrontIcon, LucideIcon> = {
  palette: Palette,
  printer: Printer,
  bag: ShoppingBag,
  truck: Truck,
  user: User,
  heart: Heart,
  mail: Mail,
  shield: ShieldCheck,
  search: Search,
};

export function StorefrontGlyph({ name, className }: { name: StorefrontIcon; className?: string }) {
  const Icon = icons[name];
  return <Icon className={className} aria-hidden />;
}
