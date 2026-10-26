const clockTime = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

/** Clock time in the viewer's time zone, with AM/PM in every locale. */
export function formatClockTime(iso: string): string {
  return clockTime.format(new Date(iso));
}
