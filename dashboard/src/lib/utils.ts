import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Indian digit grouping, matching the bot and the Worker exactly. */
export function inr(value: number | null | undefined): string {
  const n = Math.round(Number(value) || 0);
  const d = String(Math.abs(n));
  const grouped =
    d.length <= 3 ? d : d.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + d.slice(-3);
  return `${n < 0 ? '-' : ''}₹${grouped}`;
}

export function num(value: number | null | undefined): string {
  const n = Math.round(Number(value) || 0);
  const d = String(Math.abs(n));
  const grouped =
    d.length <= 3 ? d : d.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + d.slice(-3);
  return `${n < 0 ? '-' : ''}${grouped}`;
}

export const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${Math.round(Number(v) * 10) / 10}%`;
