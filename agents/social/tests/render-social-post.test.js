const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { renderHtml } = require("../scripts/lib/render-social-post");

test("renderHtml embeds local fonts and strips remote Google Fonts links", () => {
  const templatePath = path.join(__dirname, "..", "templates", "hushline-daily-desktop-template.html");
  const html = renderHtml(templatePath, {
    headline: "Trust Signals",
    image_alt_text: "A Hush Line screenshot.",
    subtext: "Sources can see public trust signals before sending a tip.",
  }, "screenshot.png", "logo-tips.png");

  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  assert.doesNotMatch(html, /fonts\.gstatic\.com/);
  assert.match(html, /Atkinson Hyperlegible Embedded/);
  assert.match(html, /data:font\/ttf;base64,/);
});
