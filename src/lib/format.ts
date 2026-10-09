import { MUSEGOD } from "./musegod";
import { safeImage } from "./validation";

// Display-only formatting shared by directory, detail and dashboard views.
const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "always" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000], ["month", 30 * 86_400_000], ["day", 86_400_000],
  ["hour", 3_600_000], ["minute", 60_000],
];
export function relativeTime(at: number, now = Date.now()) {
  if (!Number.isFinite(at)) return "—";
  const elapsed = now - at;
  if (Math.abs(elapsed) < 60_000) return "just now";
  // Days are clearer than months for young launches ("37 days ago").
  for (const [unit, size] of UNITS) {
    if (unit === "month" && Math.abs(elapsed) < 90 * 86_400_000) continue;
    if (Math.abs(elapsed) >= size) return RELATIVE.format(-Math.floor(elapsed / size), unit);
  }
  return "just now";
}
export function usdCompact(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : `$${value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })}`;
}
export function percentChange(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}
export function changeClass(value: number | null | undefined) {
  return value != null && Number.isFinite(value) && value !== 0 ? value > 0 ? "positive" : "negative" : "neutral";
}
export function dateLabel(at: number) {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export const feePercent = (basisPoints: number) => `${basisPoints / 100}%`;
// The featured MUSEGOD logo is a pinned same-origin asset; every launch image
// must pass the public-HTTPS safeImage check.
export function tokenImageSrc(token: { kind?: "launch" | "musegod"; image?: string }) {
  return token.kind === "musegod" ? MUSEGOD.image : token.image ? safeImage(token.image) : "";
}
