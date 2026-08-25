import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import type { ChartConfiguration, ChartDataset } from "chart.js";
import { createCanvas } from "canvas";
import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { auditedDelete, auditedSave } from "../replit_integrations/object_storage/audit";

const CHART_WIDTH = 800;
const CHART_HEIGHT = 500;

const chartJSNodeCanvas = new ChartJSNodeCanvas({
  width: CHART_WIDTH,
  height: CHART_HEIGHT,
  backgroundColour: "#ffffff",
});

type ChartDataItem = {
  label: string;
  value: number;
  previousValue?: number;
  color?: string;
};

type FunnelStage = { label: string; value: number; color?: string };
type FunnelGroup = { label: string; colorScheme?: "light" | "dark"; stages: FunnelStage[] };

type ChartInput = {
  type: string;
  title: string;
  description?: string;
  subtitle?: string;
  valueSuffix?: string;
  data?: ChartDataItem[];
  legend?: { label: string; color: string }[];
  groups?: FunnelGroup[];
  annotations?: { afterStage: number; text: string }[];
};

function generateScatterPng(chart: ChartInput): Promise<Buffer> {
  const width = CHART_WIDTH;
  const suffix = chart.valueSuffix ?? "";
  const points = (chart.data || [])
    .filter(Boolean)
    .map((d) => ({
      x: typeof d.value === "number" ? d.value : parseFloat(String(d.value)),
      y: typeof d.previousValue === "number" ? d.previousValue : 0,
      name: d.label || "",
      color: d.color || "#8B2E31", // brand crimson default — deliberate keep, see COLOR DECISION at LIGHT_COLORS/DARK_COLORS
    }))
    .filter((p) => !isNaN(p.x));

  const hasLegend = !!(chart.legend && chart.legend.length > 0);
  const headerHeight = chart.description ? 70 : 50;
  const legendHeight = hasLegend ? 30 : 0;
  const subtitleHeight = chart.subtitle ? 28 : 0;
  const plotHeight = 360;
  const bottomPad = 50;
  const height = headerHeight + plotHeight + bottomPad + legendHeight + subtitleHeight;

  const cvs = createCanvas(width, height);
  const ctx = cvs.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#333333";
  ctx.font = "bold 18px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(chart.title, width / 2, 30);

  if (chart.description) {
    ctx.fillStyle = "#666666";
    ctx.font = "12px sans-serif";
    ctx.fillText(chart.description, width / 2, 50);
  }

  const plotLeft = 60;
  const plotRight = width - 40;
  const plotTop = headerHeight + 10;
  const plotBottom = plotTop + plotHeight;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  let xMin = Math.min(...xs, 0);
  let xMax = Math.max(...xs, 1);
  let yMin = Math.min(...ys, 0);
  let yMax = Math.max(...ys, ys.every((y) => y === 0) ? 1 : Math.max(...ys));
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;
  const xPad = (xMax - xMin) * 0.1;
  const yPad = (yMax - yMin) * 0.1;
  xMin -= xPad; xMax += xPad;
  yMin -= yPad; yMax += yPad;

  const toX = (x: number) => plotLeft + ((x - xMin) / (xMax - xMin)) * (plotRight - plotLeft);
  const toY = (y: number) => plotBottom - ((y - yMin) / (yMax - yMin)) * (plotBottom - plotTop);

  // Gridlines + axis ticks
  ctx.strokeStyle = "#e5e5e5";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#999999";
  ctx.font = "10px sans-serif";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const gx = plotLeft + (i / ticks) * (plotRight - plotLeft);
    ctx.beginPath();
    ctx.moveTo(gx, plotTop);
    ctx.lineTo(gx, plotBottom);
    ctx.stroke();
    const xVal = xMin + (i / ticks) * (xMax - xMin);
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(xVal * 10) / 10}${suffix}`, gx, plotBottom + 16);

    const gy = plotTop + (i / ticks) * (plotBottom - plotTop);
    ctx.beginPath();
    ctx.moveTo(plotLeft, gy);
    ctx.lineTo(plotRight, gy);
    ctx.stroke();
    const yVal = yMax - (i / ticks) * (yMax - yMin);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(yVal * 10) / 10}${suffix}`, plotLeft - 6, gy + 3);
  }

  // Points + labels
  for (const p of points) {
    const cx = toX(p.x);
    const cy = toY(p.y);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();

    if (p.name) {
      ctx.fillStyle = "#333333";
      ctx.font = "500 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(p.name, cx, cy - 12);
    }
  }

  let cursorY = plotBottom + bottomPad - 14;

  if (hasLegend) {
    const items = chart.legend!;
    ctx.font = "11px sans-serif";
    const gap = 18;
    const swatch = 12;
    const itemWidths = items.map((l) => swatch + 6 + ctx.measureText(l.label).width);
    const totalWidth = itemWidths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
    let lx = width / 2 - totalWidth / 2;
    const ly = cursorY;
    items.forEach((l, idx) => {
      ctx.fillStyle = l.color;
      ctx.fillRect(lx, ly - swatch + 2, swatch, swatch);
      ctx.fillStyle = "#666666";
      ctx.textAlign = "left";
      ctx.fillText(l.label, lx + swatch + 6, ly);
      lx += itemWidths[idx] + gap;
    });
    cursorY += legendHeight;
  }

  if (chart.subtitle) {
    ctx.fillStyle = "#999999";
    ctx.font = "italic 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(chart.subtitle, width / 2, cursorY + 16);
  }

  return Promise.resolve(cvs.toBuffer("image/png"));
}

/* COLOR DECISION (Task #4567) — DELIBERATE KEEP of the crimson family.
   These charts render into "The NoBull Brief" (CEO Pulse), a branded
   editorial artifact like the client report deck, which keeps crimson by
   design; they are NOT internal-OS chrome, so the Task #4558 Liberty
   re-primary does not apply. Crimson here is a data-series/brand ramp,
   always used alongside a legend and other hues (navy/forest/amber…
   supplied by the AI prompt in server/routes/reports.ts), never as a
   standalone error/danger signal. Keep in lockstep with the prompt's
   "Available colors" list in server/routes/reports.ts. */
const LIGHT_COLORS = ["#D4A5A7", "#C48B8E", "#B47275", "#A4585C", "#944043"];
const DARK_COLORS = ["#8B2E31", "#7A2729", "#6B2023", "#5C191C", "#4D1316"];

function generateFunnelPng(chart: ChartInput): Promise<Buffer> {
  const width = CHART_WIDTH;
  const groups = chart.groups || [];
  const annotations = chart.annotations || [];
  const maxStages = Math.max(...groups.map((g) => g.stages.length));
  const stageHeight = 50;
  const stageGap = -2;
  const annotationHeight = 30;
  const headerHeight = 80;

  const annotationsByStage = new Map<number, { afterStage: number; text: string }[]>();
  for (const ann of annotations) {
    if (ann.afterStage >= 0 && ann.afterStage < maxStages - 1) {
      const existing = annotationsByStage.get(ann.afterStage) || [];
      existing.push(ann);
      annotationsByStage.set(ann.afterStage, existing);
    }
  }

  let totalAnnotationRows = 0;
  for (let s = 0; s < maxStages - 1; s++) {
    totalAnnotationRows += (annotationsByStage.get(s) || []).length;
  }

  const subtitleHeight = chart.subtitle ? 30 : 0;
  const height = headerHeight + maxStages * (stageHeight + stageGap) + totalAnnotationRows * annotationHeight + subtitleHeight + 40;

  const cvs = createCanvas(width, height);
  const ctx = cvs.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#333333";
  ctx.font = "bold 18px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(chart.title, width / 2, 30);

  if (chart.description) {
    ctx.fillStyle = "#666666";
    ctx.font = "12px sans-serif";
    ctx.fillText(chart.description, width / 2, 50);
  }

  const allValues = groups.flatMap((g) => g.stages.map((s) => s.value));
  const maxValue = Math.max(...allValues, 1);
  const groupWidth = (width - 60) / groups.length;

  groups.forEach((group, gi) => {
    const centerX = 30 + gi * groupWidth + groupWidth / 2;
    ctx.fillStyle = "#333333";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(group.label.toUpperCase(), centerX, headerHeight - 10);
  });

  let currentY = headerHeight;

  for (let si = 0; si < maxStages; si++) {
    groups.forEach((group, gi) => {
      const centerX = 30 + gi * groupWidth + groupWidth / 2;
      const colors = group.colorScheme === "light" ? LIGHT_COLORS : DARK_COLORS;
      const stage = group.stages[si];
      if (!stage) return;

      const widthPct = Math.max(0.3, stage.value / maxValue);
      const barWidth = groupWidth * 0.85 * widthPct;
      const color = stage.color || colors[si % colors.length];
      const isLast = si === group.stages.length - 1;
      const inset = barWidth * 0.04;

      ctx.fillStyle = color;
      if (!isLast) {
        ctx.beginPath();
        ctx.moveTo(centerX - barWidth / 2, currentY);
        ctx.lineTo(centerX + barWidth / 2, currentY);
        ctx.lineTo(centerX + barWidth / 2 - inset, currentY + stageHeight);
        ctx.lineTo(centerX - barWidth / 2 + inset, currentY + stageHeight);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(centerX - barWidth / 2 + inset, currentY);
        ctx.lineTo(centerX + barWidth / 2 - inset, currentY);
        ctx.lineTo(centerX, currentY + stageHeight);
        ctx.closePath();
        ctx.fill();
      }

      ctx.fillStyle = "#ffffff";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(stage.label, centerX, currentY + stageHeight / 2 - 4);
      ctx.font = "bold 14px sans-serif";
      ctx.fillText(stage.value.toLocaleString(), centerX, currentY + stageHeight / 2 + 14);
    });

    currentY += stageHeight + stageGap;

    const stageAnnotations = annotationsByStage.get(si);
    if (stageAnnotations) {
      for (const ann of stageAnnotations) {
        const pillWidth = Math.min(ctx.measureText(ann.text).width + 40, width - 60);
        const pillX = width / 2 - pillWidth / 2;
        const pillY = currentY + 4;
        const pillH = 22;

        ctx.fillStyle = "#FEF3C7";
        ctx.strokeStyle = "rgba(245, 158, 11, 0.3)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pillX + pillH / 2, pillY);
        ctx.lineTo(pillX + pillWidth - pillH / 2, pillY);
        ctx.arc(pillX + pillWidth - pillH / 2, pillY + pillH / 2, pillH / 2, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(pillX + pillH / 2, pillY + pillH);
        ctx.arc(pillX + pillH / 2, pillY + pillH / 2, pillH / 2, Math.PI / 2, -Math.PI / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#92400E";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(ann.text, width / 2, pillY + pillH / 2 + 4);

        currentY += annotationHeight;
      }
    }
  }

  if (chart.subtitle) {
    ctx.fillStyle = "#999999";
    ctx.font = "italic 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(chart.subtitle, width / 2, currentY + 20);
  }

  return Promise.resolve(cvs.toBuffer("image/png"));
}

async function generateBarChartPng(chart: ChartInput): Promise<Buffer> {
  const data = chart.data || [];
  const suffix = chart.valueSuffix ?? "%";
  const hasComparison = chart.type === "comparison" && data.some((d) => d.previousValue && d.previousValue > 0);

  const labels = data.map((d) => d.label);
  const currentValues = data.map((d) => d.value);
  const colors = data.map((d) => d.color || "#8B2E31"); // brand crimson default — deliberate keep, see COLOR DECISION at LIGHT_COLORS/DARK_COLORS

  const datasets: ChartDataset<"bar", number[]>[] = [];

  if (hasComparison) {
    datasets.push({
      label: "Previous",
      data: data.map((d) => d.previousValue || 0),
      backgroundColor: "#9CA3AF",
      borderRadius: 4,
      barPercentage: 0.7,
    });
  }

  datasets.push({
    label: "Current",
    data: currentValues,
    backgroundColor: colors,
    borderRadius: 4,
    barPercentage: 0.7,
  });

  const configuration: ChartConfiguration<"bar", number[], string> = {
    type: "bar",
    data: { labels, datasets },
    plugins: chart.subtitle
      ? [
          {
            id: "ceoPulseCaption",
            afterDraw(chartInst: any) {
              const { ctx: c, width: w, height: h } = chartInst;
              c.save();
              c.font = "italic 12px sans-serif";
              c.fillStyle = "#999999";
              c.textAlign = "center";
              c.fillText(chart.subtitle as string, w / 2, h - 8);
              c.restore();
            },
          },
        ]
      : [],
    options: {
      indexAxis: "y",
      responsive: false,
      layout: { padding: { bottom: chart.subtitle ? 22 : 0 } },
      plugins: {
        title: {
          display: true,
          text: chart.title,
          font: { size: 18, weight: "bold" },
          color: "#333333",
          padding: { bottom: chart.description ? 4 : 16 },
        },
        subtitle: {
          display: !!chart.description,
          text: chart.description || "",
          font: { size: 12 },
          color: "#666666",
          padding: { bottom: 16 },
        },
        legend: {
          display: hasComparison || !!(chart.legend && chart.legend.length > 0),
          labels: {
            font: { size: 11 },
            color: "#666666",
            ...(chart.legend && chart.legend.length > 0
              ? {
                  generateLabels: () =>
                    chart.legend!.map((l) => ({
                      text: l.label,
                      fillStyle: l.color,
                      strokeStyle: l.color,
                      lineWidth: 0,
                    })),
                }
              : {}),
          },
        },
      },
      scales: {
        x: {
          ticks: {
            callback: (v: string | number) => `${v}${suffix}`,
            color: "#333333",
            font: { size: 11 },
          },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
        y: {
          ticks: {
            color: "#333333",
            font: { size: 11 },
          },
          grid: { display: false },
        },
      },
    },
  };

  return chartJSNodeCanvas.renderToBuffer(configuration);
}

export async function generateChartImage(chart: ChartInput): Promise<Buffer> {
  if (chart.type === "funnel" && chart.groups && chart.groups.length > 0) {
    return generateFunnelPng(chart);
  }
  if ((chart.type === "scatter" || chart.type === "bubble") && chart.data && chart.data.length > 0) {
    return generateScatterPng(chart);
  }
  return generateBarChartPng(chart);
}

// Exported for the supporting-image service (Task #4293), which stores
// uploaded brief images under the same public ceo-pulse/<monthKey>/ prefix.
export function getPublicBucketPath(): { bucketName: string; basePath: string } {
  const searchPaths = (process.env.PUBLIC_OBJECT_SEARCH_PATHS || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (searchPaths.length === 0) {
    throw new Error("PUBLIC_OBJECT_SEARCH_PATHS not configured");
  }
  const fullPath = searchPaths[0];
  const parts = fullPath.replace(/^\//, "").split("/");
  const bucketName = parts[0];
  const basePath = parts.slice(1).join("/");
  return { bucketName, basePath };
}

export async function generateAndStoreChartImages(
  monthKey: string,
  charts: ChartInput[]
): Promise<{ success: boolean; generatedCount: number }> {
  const { bucketName, basePath } = getPublicBucketPath();
  const bucket = objectStorageClient.bucket(bucketName);
  let generatedCount = 0;

  for (let i = 0; i < charts.length; i++) {
    const chart = charts[i];
    const pngBuffer = await generateChartImage(chart);
    const objectPath = `${basePath}/ceo-pulse/${monthKey}/chart-${i + 1}.png`;
    const file = bucket.file(objectPath);

    await auditedSave(file, pngBuffer, {
      contentType: "image/png",
      metadata: {
        cacheControl: "public, max-age=3600",
      },
    });

    generatedCount++;
  }

  for (let staleIdx = charts.length + 1; staleIdx <= 3; staleIdx++) {
    const stalePath = `${basePath}/ceo-pulse/${monthKey}/chart-${staleIdx}.png`;
    try {
      await auditedDelete(bucket.file(stalePath), { ignoreNotFound: true });
    } catch {
      // ignore cleanup errors
    }
  }

  return { success: true, generatedCount };
}

export function getChartImageUrl(monthKey: string, chartIndex: number): string {
  return `/api/ceo-pulse-charts/${monthKey}/chart-${chartIndex}.png`;
}

export function resolveChartPlaceholders(
  html: string,
  monthKey: string,
  availableIndices: Set<number>,
  options: { stripMissing?: boolean } = {}
): string {
  let result = html;
  const stripMissing = options.stripMissing === true;

  // Strip any chart placeholders that go beyond what we model (defensive),
  // and handle 1..N for known chart slots.
  result = result.replace(/\{\{chart-(\d+)\}\}/g, (_match, idxStr) => {
    const i = parseInt(idxStr, 10);
    if (availableIndices.has(i)) {
      const url = getChartImageUrl(monthKey, i);
      return `<img src="${url}" alt="Chart ${i}" style="max-width: 100%; height: auto; margin: 16px 0; border-radius: 8px;" />`;
    }
    if (stripMissing) {
      return "";
    }
    return `<div style="width:100%;padding:40px 20px;background:#f5f0e8;border:2px dashed #c9bfaf;border-radius:10px;text-align:center;margin:16px 0;font-family:Arial,sans-serif;"><span style="font-size:14px;color:#8a7e6e;">Chart ${i} — image not yet generated. Re-analyze report to create chart images.</span></div>`;
  });

  return result;
}

export async function checkAvailableChartImages(
  monthKey: string,
  chartCount: number
): Promise<Set<number>> {
  const available = new Set<number>();
  if (chartCount === 0) return available;

  try {
    const { ObjectStorageService } = await import("../replit_integrations/object_storage/objectStorage");
    const objService = new ObjectStorageService();
    const checks = Array.from({ length: Math.min(chartCount, 3) }, (_, i) => i + 1);
    await Promise.all(
      checks.map(async (idx) => {
        try {
          const file = await objService.searchPublicObject(`ceo-pulse/${monthKey}/chart-${idx}.png`);
          if (file) available.add(idx);
        } catch {
          // skip
        }
      })
    );
  } catch {
    // if object storage is unavailable, return empty set
  }

  return available;
}
