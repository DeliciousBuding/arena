/**
 * agent 评测可视化 SVG 渲染器（arena-bench-v1）。
 *
 * 纯字符串生成、零依赖、无网络/文件/进程访问：输入 0-1 数值，输出完整
 * <svg> 文档字符串（深色主题 #0d1117 风格），供 CLI 写盘/内联 HTML。
 *
 * 输出约定：所有数值先 clamp 到 0-1（非有限输入按 0），文本做 XML 转义，
 * 保证输出不含 NaN/undefined 字面量。
 */

import type { AgentProfile } from "./agent-profile.ts";

export interface HeatmapCell {
  /** 0-1 强度（对角线渲染层强制为 0.5 灰，见 heatmapSvg）。 */
  readonly value: number;
  /** 格子内辅助小字（如 "12/20"）。 */
  readonly label: string;
}

const BG_COLOR = "#0d1117";
const PANEL_COLOR = "#161b22";
const GRID_COLOR = "#30363d";
const TEXT_COLOR = "#e6edf3";
const MUTED_COLOR = "#8b949e";

const HEAT_RED = "#d73a49";
const HEAT_AMBER = "#e3b341";
const HEAT_GREEN = "#3fb950";

/** 0-1 钳制；NaN/Infinity 按 0（输出永不出现 NaN 字面量）。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPercent(value: number): string {
  return `${(clamp01(value) * 100).toFixed(1)}%`;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function lerpColor(from: string, to: string, t: number): string {
  const [fr, fg, fb] = hexToRgb(from);
  const [tr, tg, tb] = hexToRgb(to);
  return rgbToHex(fr + (tr - fr) * t, fg + (tg - fg) * t, fb + (tb - fb) * t);
}

/** heatmap 色阶：0 红(#d73a49) → 0.5 琥珀(#e3b341) → 1 绿(#3fb950)。 */
function heatColor(value: number): string {
  const v = clamp01(value);
  if (v < 0.5) {
    return lerpColor(HEAT_RED, HEAT_AMBER, v * 2);
  }
  return lerpColor(HEAT_AMBER, HEAT_GREEN, (v - 0.5) * 2);
}

const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** 对打矩阵热力图：行=列对称；对角线渲染层强制 0.5（灰，自对比无意义）。
 *  矩形变体（rows/cols 显式给出）：场景×条目排名热图用，无对角线强制。 */
export function heatmapSvg(opts: {
  readonly agents?: readonly string[];
  readonly rows?: readonly string[];
  readonly cols?: readonly string[];
  readonly cell: (row: string, col: string) => HeatmapCell;
}): string {
  // agents 提供时 rows=cols=agents（方形对称矩阵，对角线强制 0.5）；
  // rows/cols 提供时为矩形矩阵（row 集合 × col 集合，行≠列语义）。
  const rows = opts.rows ?? opts.agents ?? [];
  const cols = opts.cols ?? opts.agents ?? rows;
  const forceDiagonal = opts.agents !== undefined;
  const cell = opts.cell;
  const n = rows.length;
  const m = cols.length;
  const cellSize = 100;
  const padLeft = 150;
  const padTop = 56;
  const padRight = 24;
  const legendHeight = 60;
  const padBottom = 20;
  const width = padLeft + m * cellSize + padRight;
  const height = padTop + n * cellSize + legendHeight + padBottom;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_STACK}">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="${BG_COLOR}"/>`);
  parts.push(
    `<defs><linearGradient id="heat-legend" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0%" stop-color="${HEAT_RED}"/>` +
      `<stop offset="50%" stop-color="${HEAT_AMBER}"/>` +
      `<stop offset="100%" stop-color="${HEAT_GREEN}"/>` +
      `</linearGradient></defs>`,
  );

  for (let col = 0; col < m; col++) {
    const cx = padLeft + col * cellSize + cellSize / 2;
    parts.push(
      `<text x="${cx}" y="${padTop - 22}" text-anchor="middle" fill="${TEXT_COLOR}" font-size="14">${escapeXml(cols[col])}</text>`,
    );
  }

  for (let row = 0; row < n; row++) {
    const cy = padTop + row * cellSize + cellSize / 2;
    parts.push(
      `<text x="${padLeft - 14}" y="${cy}" text-anchor="end" dominant-baseline="middle" fill="${TEXT_COLOR}" font-size="14">${escapeXml(rows[row])}</text>`,
    );
    for (let col = 0; col < m; col++) {
      const hit = cell(rows[row], cols[col]);
      const isDiagonal = forceDiagonal && row === col;
      const value = isDiagonal ? 0.5 : clamp01(hit.value);
      const x = padLeft + col * cellSize;
      const y = padTop + row * cellSize;
      parts.push(
        `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${heatColor(value)}" stroke="${BG_COLOR}" stroke-width="2"/>`,
      );
      parts.push(
        `<text x="${x + cellSize / 2}" y="${y + cellSize / 2 - 8}" text-anchor="middle" fill="#ffffff" font-size="20" font-weight="600">${formatPercent(value)}</text>`,
      );
      if (hit.label !== "") {
        parts.push(
          `<text x="${x + cellSize / 2}" y="${y + cellSize / 2 + 14}" text-anchor="middle" fill="#ffffff" fill-opacity="0.85" font-size="12">${escapeXml(hit.label)}</text>`,
        );
      }
    }
  }

  const legendX = padLeft;
  const legendY = padTop + n * cellSize + 20;
  const legendW = 300;
  parts.push(
    `<rect x="${legendX}" y="${legendY}" width="${legendW}" height="12" rx="3" fill="url(#heat-legend)"/>`,
  );
  parts.push(`<text x="${legendX}" y="${legendY + 32}" fill="${MUTED_COLOR}" font-size="12">0%</text>`);
  parts.push(
    `<text x="${legendX + legendW / 2}" y="${legendY + 32}" text-anchor="middle" fill="${MUTED_COLOR}" font-size="12">50%</text>`,
  );
  parts.push(
    `<text x="${legendX + legendW}" y="${legendY + 32}" text-anchor="end" fill="${MUTED_COLOR}" font-size="12">100%</text>`,
  );
  parts.push("</svg>");
  return parts.join("\n");
}

const RADAR_AXES: readonly { readonly label: string; readonly key: keyof AgentProfile }[] = [
  { label: "经济", key: "economy" },
  { label: "军事", key: "military" },
  { label: "生存", key: "survival" },
  { label: "信标", key: "beacon" },
  { label: "扩张", key: "expansion" },
];

const RADAR_PALETTE = [
  "#58a6ff",
  "#3fb950",
  "#f78166",
  "#d2a8ff",
  "#e3b341",
  "#79c0ff",
  "#ff7b72",
  "#56d4dd",
];

/** 缺省颜色：按 title 哈希从调色板稳定选取（同 title 恒同色）。 */
function pickColor(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  }
  return RADAR_PALETTE[hash % RADAR_PALETTE.length];
}

/** 单 agent 五轴雷达图：五边形网格 4 层，中文轴名，填充 30% 透明度 + 描边。 */
export function radarSvg(opts: {
  readonly title: string;
  readonly profile: AgentProfile;
  readonly color?: string;
}): string {
  const color = opts.color ?? pickColor(opts.title);
  const width = 640;
  const height = 580;
  const cx = 320;
  const cy = 316;
  const radius = 180;
  const gridLayers = 4;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_STACK}">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="${BG_COLOR}"/>`);
  parts.push(
    `<text x="${cx}" y="40" text-anchor="middle" fill="${TEXT_COLOR}" font-size="20" font-weight="600">${escapeXml(opts.title)}</text>`,
  );

  const angleFor = (index: number): number => (Math.PI / 180) * (-90 + index * (360 / RADAR_AXES.length));
  const pointAt = (index: number, ratio: number): readonly [number, number] => {
    const angle = angleFor(index);
    return [cx + Math.cos(angle) * radius * ratio, cy + Math.sin(angle) * radius * ratio];
  };
  const formatPoint = (point: readonly [number, number]): string =>
    `${point[0].toFixed(2)},${point[1].toFixed(2)}`;

  for (let layer = gridLayers; layer >= 1; layer--) {
    const ratio = layer / gridLayers;
    const points = RADAR_AXES.map((_, index) => formatPoint(pointAt(index, ratio))).join(" ");
    parts.push(
      `<polygon points="${points}" fill="${layer === gridLayers ? PANEL_COLOR : "none"}" stroke="${GRID_COLOR}" stroke-width="1"/>`,
    );
  }
  for (let index = 0; index < RADAR_AXES.length; index++) {
    const [x, y] = pointAt(index, 1);
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${GRID_COLOR}" stroke-width="1"/>`);
  }

  const valuePoints = RADAR_AXES.map((axis, index) =>
    formatPoint(pointAt(index, clamp01(opts.profile[axis.key]))),
  ).join(" ");
  parts.push(
    `<polygon points="${valuePoints}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`,
  );
  for (let index = 0; index < RADAR_AXES.length; index++) {
    const axis = RADAR_AXES[index];
    const value = clamp01(opts.profile[axis.key]);
    const [x, y] = pointAt(index, value);
    parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="4" fill="${color}"/>`);
    parts.push(
      `<text x="${x.toFixed(2)}" y="${(y - 10).toFixed(2)}" text-anchor="middle" fill="${TEXT_COLOR}" font-size="12">${formatPercent(value)}</text>`,
    );
  }

  for (let index = 0; index < RADAR_AXES.length; index++) {
    const axis = RADAR_AXES[index];
    const [x, y] = pointAt(index, 1.3);
    const anchor = x > cx + 24 ? "start" : x < cx - 24 ? "end" : "middle";
    const dy = y < cy - 10 ? 6 : y > cy + 10 ? 14 : 4;
    parts.push(
      `<text x="${x.toFixed(2)}" y="${(y + dy).toFixed(2)}" text-anchor="${anchor}" fill="${TEXT_COLOR}" font-size="16" font-weight="600">${escapeXml(axis.label)}</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/** 横向柱状图（右伸）：渐变柱 + 数值标签 + 可选 detail 小字。 */
export function barsSvg(opts: {
  readonly title: string;
  readonly items: readonly {
    readonly label: string;
    readonly value: number;
    readonly detail?: string;
  }[];
}): string {
  const { title, items } = opts;
  const labelWidth = 190;
  const barMaxWidth = 420;
  const valueGap = 10;
  const rowGap = 8;
  const barHeight = 18;
  const titleHeight = 64;
  const bottomPad = 16;
  const width = labelWidth + barMaxWidth + 150;
  const rowHeightFor = (item: { readonly detail?: string }): number =>
    item.detail !== undefined && item.detail !== "" ? 46 : 34;
  const contentHeight = items.reduce((sum, item) => sum + rowHeightFor(item) + rowGap, 0);
  const height = titleHeight + contentHeight + bottomPad;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_STACK}">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="${BG_COLOR}"/>`);
  parts.push(
    `<defs><linearGradient id="bar-grad" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0%" stop-color="#1f6feb"/>` +
      `<stop offset="100%" stop-color="#79c0ff"/>` +
      `</linearGradient></defs>`,
  );
  parts.push(
    `<text x="20" y="40" fill="${TEXT_COLOR}" font-size="18" font-weight="600">${escapeXml(title)}</text>`,
  );

  let cursorY = titleHeight;
  for (const item of items) {
    const rowHeight = rowHeightFor(item);
    const barY = cursorY + (rowHeight - barHeight) / 2;
    const value = clamp01(item.value);
    const barWidth = Math.max(2, barMaxWidth * value);
    parts.push(
      `<rect x="${labelWidth}" y="${barY}" width="${barMaxWidth}" height="${barHeight}" rx="4" fill="${PANEL_COLOR}"/>`,
    );
    parts.push(
      `<rect x="${labelWidth}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4" fill="url(#bar-grad)"/>`,
    );
    parts.push(
      `<text x="${labelWidth + barWidth + valueGap}" y="${barY + 13}" fill="${TEXT_COLOR}" font-size="13">${formatPercent(value)}</text>`,
    );
    if (item.detail !== undefined && item.detail !== "") {
      parts.push(
        `<text x="16" y="${cursorY + 17}" fill="${TEXT_COLOR}" font-size="13">${escapeXml(item.label)}</text>`,
      );
      parts.push(
        `<text x="16" y="${cursorY + 34}" fill="${MUTED_COLOR}" font-size="11">${escapeXml(item.detail)}</text>`,
      );
    } else {
      parts.push(
        `<text x="16" y="${cursorY + rowHeight / 2 + 4}" fill="${TEXT_COLOR}" font-size="13">${escapeXml(item.label)}</text>`,
      );
    }
    cursorY += rowHeight + rowGap;
  }
  parts.push("</svg>");
  return parts.join("\n");
}
