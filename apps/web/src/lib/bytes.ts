export const STORAGE_PRESETS = [
  { value: 536_870_912, label: "512 MB" },
  { value: 1_073_741_824, label: "1 GB" },
  { value: 2_147_483_648, label: "2 GB" },
  { value: 5_368_709_120, label: "5 GB" },
  { value: 10_737_418_240, label: "10 GB" },
  { value: 21_474_836_480, label: "20 GB" },
  { value: 53_687_091_200, label: "50 GB" },
  { value: 107_374_182_400, label: "100 GB" },
];

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${trimNum(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${trimNum(bytes / 1024 ** 2)} MB`;
  return `${trimNum(bytes / 1024 ** 3)} GB`;
}

export function presetLabel(bytes: number) {
  return STORAGE_PRESETS.find(o => o.value === bytes)?.label ?? formatBytes(bytes);
}

export function usagePercent(used: number, quota: number) {
  if (quota <= 0) return 100;
  return Math.min(100, Math.max(0, (used / quota) * 100));
}

function trimNum(n: number) {
  if (n >= 100) return String(Math.round(n));
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}
