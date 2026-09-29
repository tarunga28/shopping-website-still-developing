/**
 * Campaign windows for announcements, banners and homepage modules.
 * Invalid dates fail closed so a bad CMS value never shows a stale promo.
 */

export interface ScheduleWindow {
  active: boolean;
  /** ISO-8601. Omitted or null means "no start bound". */
  startsAt?: string | null;
  /** ISO-8601. Omitted or null means "no end bound". */
  endsAt?: string | null;
}

function parseBound(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isScheduleActive(item: ScheduleWindow, now = new Date()): boolean {
  if (!item.active) return false;

  if (item.startsAt) {
    const start = parseBound(item.startsAt);
    if (!start || now < start) return false;
  }

  if (item.endsAt) {
    const end = parseBound(item.endsAt);
    if (!end || now >= end) return false;
  }

  return true;
}

export function filterScheduled<T extends ScheduleWindow>(items: readonly T[], now = new Date()): T[] {
  return items.filter((item) => isScheduleActive(item, now));
}
