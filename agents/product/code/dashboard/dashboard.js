"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const statusIcons = {
  healthy: "✓",
  running: "●",
  failed: "×",
  warning: "!",
  paused: "Ⅱ",
};

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function smoothLinePath(points) {
  if (points.length === 0) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midpointX = (previous.x + current.x) / 2;
    path += ` C ${midpointX} ${previous.y}, ${midpointX} ${current.y}, ${current.x} ${current.y}`;
  }
  return path;
}

function renderLegend(series) {
  const legend = document.getElementById("chart-legend");
  legend.replaceChildren();
  series.forEach((item) => {
    const wrapper = document.createElement("span");
    wrapper.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = item.color;
    const label = document.createElement("span");
    label.textContent = item.label;
    wrapper.append(swatch, label);
    legend.append(wrapper);
  });
}

function renderChart(activity) {
  const container = document.getElementById("activity-chart");
  container.replaceChildren();
  const width = 760;
  const height = 280;
  const margin = { top: 18, right: 18, bottom: 42, left: 34 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(1, ...activity.series.flatMap((item) => item.values));
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });

  for (let step = 0; step <= 4; step += 1) {
    const y = margin.top + (plotHeight * step) / 4;
    svg.append(
      svgElement("line", {
        x1: margin.left,
        x2: width - margin.right,
        y1: y,
        y2: y,
        class: "chart-grid-line",
      }),
    );
    const label = svgElement("text", {
      x: margin.left - 8,
      y: y + 3,
      "text-anchor": "end",
      class: "chart-axis-label",
    });
    label.textContent = String(Math.round(maxValue * (1 - step / 4)));
    svg.append(label);
  }

  activity.labels.forEach((label, index) => {
    if (index % 2 !== 0 && index !== activity.labels.length - 1) return;
    const x = margin.left + (plotWidth * index) / Math.max(1, activity.labels.length - 1);
    const text = svgElement("text", {
      x,
      y: height - 15,
      "text-anchor": "middle",
      class: "chart-axis-label",
    });
    text.textContent = label.slice(5);
    svg.append(text);
  });

  activity.series.forEach((item) => {
    const points = item.values.map((value, index) => {
      const x = margin.left + (plotWidth * index) / Math.max(1, item.values.length - 1);
      const y = margin.top + plotHeight - (plotHeight * value) / maxValue;
      return { x, y };
    });
    svg.append(
      svgElement("path", {
        d: smoothLinePath(points),
        fill: "none",
        stroke: item.color,
        "stroke-width": 3,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
  });
  container.append(svg);
  renderLegend(activity.series);
}

function renderActivityTable(activity) {
  const table = document.getElementById("activity-table");
  table.replaceChildren();
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Date", ...activity.series.map((item) => item.label)].forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);
  const body = document.createElement("tbody");
  activity.labels.forEach((label, index) => {
    const row = document.createElement("tr");
    [label, ...activity.series.map((item) => item.values[index])].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.append(cell);
    });
    body.append(row);
  });
  table.append(head, body);
}

function renderRunners(runners) {
  const list = document.getElementById("runner-list");
  list.replaceChildren();
  runners.forEach((runner) => {
    const row = document.createElement("article");
    row.className = `runner-row status-${runner.status}`;
    const icon = document.createElement("span");
    icon.className = "status-icon";
    icon.setAttribute("aria-label", runner.status);
    icon.textContent = statusIcons[runner.status] || "?";
    const details = document.createElement("div");
    const name = document.createElement("p");
    name.className = "runner-name";
    name.textContent = runner.name;
    const action = document.createElement("p");
    action.className = "runner-action";
    action.textContent = runner.action;
    const meta = document.createElement("p");
    meta.className = "runner-meta";
    const lastSeen = runner.last_event_date ? ` · Last event ${runner.last_event_date}` : "";
    meta.textContent = `${runner.cadence}${lastSeen}`;
    details.append(name, action, meta);
    const group = document.createElement("span");
    group.className = "runner-group";
    group.textContent = runner.group;
    row.append(icon, details, group);
    list.append(row);
  });
}

function setExternalLink(id, url, label) {
  const link = document.getElementById(id);
  if (!link) return;
  const available = typeof url === "string" && url.startsWith("https://");
  link.hidden = !available;
  link.removeAttribute("href");
  if (available) {
    link.href = url;
    link.textContent = label;
  }
}

function renderLastNewsPost(newsPost) {
  const empty = document.getElementById("news-empty");
  const content = document.getElementById("news-content");
  const available = Boolean(newsPost && newsPost.available);
  empty.hidden = available;
  content.hidden = !available;
  if (!available) return;

  setText("news-title", newsPost.title || "Published news post");
  setText("news-source", newsPost.source || "Approved source");
  const date = document.getElementById("news-date");
  date.dateTime = newsPost.published_at || newsPost.planned_date;
  date.textContent = newsPost.planned_date;
  setExternalLink(
    "news-public-link",
    newsPost.public_url,
    newsPost.platform ? `View on ${newsPost.platform}` : "View post",
  );
  setExternalLink("news-article-link", newsPost.article_url, "Read source");
}

function renderLastSocialPostStatus(delivery) {
  const platforms = delivery?.platforms || {};
  const date = document.getElementById("delivery-date");
  date.dateTime = delivery?.planned_date || "";
  date.textContent = delivery?.planned_date || "Unavailable";
  ["linkedin", "mastodon", "bluesky"].forEach((platform) => {
    const element = document.getElementById(`delivery-${platform}`);
    const published = platforms[platform] === true;
    element.className = `platform-status ${published ? "is-published" : "is-missing"}`;
    element.textContent = published ? "✓" : "×";
    element.setAttribute(
      "aria-label",
      `${platform} ${published ? "published" : "not published"}`,
    );
  });
}

function renderDashboard(data) {
  const {
    summary,
    leads,
    activity,
    runners,
    last_news_post: lastNewsPost,
    last_social_post_status: lastSocialPostStatus,
  } = data;
  setText("healthy-count", `${summary.healthy}/${summary.total}`);
  setText("healthy-detail", `${summary.running} running · ${summary.paused} paused`);
  setText("activity-count", summary.activity_7d);
  setText("qualified-count", summary.qualified_leads);
  setText("failure-count", summary.failed);
  setText("lead-qualified", leads.qualified);
  setText("lead-screened", leads.screened_out);
  setText("lead-blocked", leads.blocked);
  setText("lead-total", leads.total);

  const failureCard = document.getElementById("failure-card");
  failureCard.classList.toggle("is-failed", summary.failed > 0);
  const alert = document.getElementById("alert-banner");
  alert.hidden = summary.failed === 0;
  alert.textContent =
    summary.failed === 1
      ? "1 runner reports a failed latest action. Review the red status below."
      : `${summary.failed} runners report failed latest actions. Review the red statuses below.`;

  renderChart(activity);
  renderActivityTable(activity);
  renderRunners(runners);
  renderLastNewsPost(lastNewsPost);
  renderLastSocialPostStatus(lastSocialPostStatus);
  const updated = new Date(data.generated_at);
  setText("updated-at", `Updated ${updated.toLocaleString()}`);
  setText("refresh-status", `Live · refreshes every ${data.refresh_seconds}s`);
}

async function refreshDashboard() {
  try {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error(`Dashboard request failed: ${response.status}`);
    renderDashboard(await response.json());
  } catch (_error) {
    setText("refresh-status", "Dashboard data unavailable");
    const alert = document.getElementById("alert-banner");
    alert.hidden = false;
    alert.textContent = "The dashboard could not refresh its local metrics.";
  }
}

refreshDashboard();
window.setInterval(refreshDashboard, 15000);
