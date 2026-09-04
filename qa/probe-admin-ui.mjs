/** Drives the admin screen the way an organizer actually taps it. */
import { chromium } from "@playwright/test";
import {
  BASE, admin, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings, asOrganizer, check, note, summary, call,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

try {
  await teardown();
  const fx = await setup();
  const alice = fx.player("__qa Alice");
  const red1 = fx.teamOf("__qa Red", 1);
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries: [{ playerId: alice.id, teamId: red1.id }] }) });
  const added = await call("/api/admin/tasks", { method: "POST", body: JSON.stringify({ round: 1, title: "__qa tap to edit me", points: 2 }) });
  const taskId = added.body.id;

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asOrganizer(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  console.log("\n1. Tabs");
  for (const name of ["event", "roster", "tasks", "health"]) {
    const btn = page.getByRole("button", { name, exact: true }).first();
    const found = await btn.count() > 0;
    check(`"${name}" tab exists`, found);
    if (found) {
      await btn.click();
      await page.waitForTimeout(1200);
      const active = await btn.getAttribute("class");
      check(`"${name}" tab becomes active when tapped`, String(active).includes("btn-primary"), String(active));
    }
  }

  console.log("\n2. Tasks — tap a row to edit it");
  await page.getByRole("button", { name: "tasks", exact: true }).first().click();
  await page.waitForTimeout(1500);
  check("the tasks tab explains tap-to-edit",
    await page.getByText("Tap a task to change its wording", { exact: false }).count() > 0);

  const row = page.getByRole("button", { name: /__qa tap to edit me/ }).first();
  check("the seeded task is listed and tappable", await row.count() > 0);
  await row.click();
  await page.waitForTimeout(800);

  const editorOpen = await page.getByRole("button", { name: "Save" }).count();
  check("tapping a task opens an inline editor with a Save button", editorOpen > 0);

  const ta = page.locator("textarea").first();
  check("the editor is prefilled with the current title",
    (await ta.inputValue()) === "__qa tap to edit me", await ta.inputValue());
  check("the editor offers the point presets used by the real tasks",
    (await page.locator(".card button.btn-sm").filter({ hasText: /^(1|3|5|7|10)$/ }).count()) >= 5);
  check("the editor offers the video-only and secret flags",
    (await page.getByRole("button", { name: "video only" }).count()) > 0 &&
    (await page.getByRole("button", { name: "secret" }).count()) > 0);

  // Scope every control to the editor card itself; the task list behind it also
  // contains buttons whose labels are bare numbers.
  const editor = page.locator(".card").filter({ has: page.getByRole("button", { name: "Save" }) }).last();
  await ta.fill("__qa edited by tapping");
  await editor.getByRole("button", { name: "5", exact: true }).click();
  await editor.getByRole("button", { name: "video only" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(2500);

  const { data: after } = await admin.from("tasks").select("title,points,requires_video").eq("id", taskId).single();
  check("editing a task title through the UI persists", after.title === "__qa edited by tapping", JSON.stringify(after));
  check("editing the point value through the UI persists", after.points === 5, JSON.stringify(after));
  check("toggling video-only through the UI persists", after.requires_video === true, JSON.stringify(after));
  note(`task is now: ${JSON.stringify(after)}`);
  check("the edited task shows its new title in the list",
    await page.getByText("__qa edited by tapping", { exact: false }).count() > 0);

  console.log("\n3. Roster — tap a player to reassign");
  await page.getByRole("button", { name: "roster", exact: true }).first().click();
  await page.waitForTimeout(1500);
  const prow = page.getByRole("button", { name: /__qa Alice/ }).first();
  check("player row is tappable", await prow.count() > 0);
  await prow.click();
  await page.waitForTimeout(800);
  const rosterEditor = (await page.getByRole("button", { name: "Save" }).count())
    + (await page.locator("select").count());
  check("tapping a player opens a reassign/rename editor", rosterEditor > 0,
    (await page.locator(".card").first().innerText()).replace(/\s+/g," ").slice(0,120));
  await page.keyboard.press("Escape");

  console.log("\n4. Event tab controls");
  await page.getByRole("button", { name: "event", exact: true }).first().click();
  await page.waitForTimeout(1200);
  check("round buttons present", await page.getByRole("button", { name: "Round 1", exact: true }).count() > 0);
  check("submissions toggle present", await page.getByRole("button", { name: /tap to (close|open)/ }).count() > 0);
  check("notice box present", await page.getByPlaceholder("Secret challenge is live", { exact: false }).count() > 0);
  check("notice has Post and Clear controls",
    (await page.getByRole("button", { name: "Post" }).count()) > 0 &&
    (await page.getByRole("button", { name: "Clear" }).count()) > 0);

  console.log("\n5. Health tab — the submission reset");
  await page.getByRole("button", { name: "health", exact: true }).first().click();
  await page.waitForTimeout(1500);

  // The card only exists when the server's ALLOW_RESET switch is on, so ask the
  // server rather than assuming either state. Both branches are worth an
  // assertion: an organizer must never be left with no explanation for a control
  // that is not there.
  const { body: adminData } = await call("/api/admin/data");
  const resetButton = page.getByRole("button", { name: /Delete \d+ submissions? and their media/ });

  if (adminData.resetEnabled) {
    check("the reset card is offered when ALLOW_RESET is on", (await resetButton.count()) > 0);
    check("the reset card warns there is no undo",
      (await page.getByText("There is no undo", { exact: false }).count()) > 0);
    check("the reset button starts disabled", await resetButton.isDisabled());

    // Typing the word is the guard a mis-tap cannot get past. The box is
    // case-insensitive -- the client always posts the literal word -- but a
    // partial word must leave the button dead.
    await page.getByPlaceholder("RESET").fill("reset");
    await page.waitForTimeout(300);
    check("the box accepts the word in lower case", await resetButton.isEnabled());
    await page.getByPlaceholder("RESET").fill("RESE");
    await page.waitForTimeout(300);
    check("a partial word leaves the button disabled", await resetButton.isDisabled());
    await page.getByPlaceholder("RESET").fill("");
    await page.waitForTimeout(300);
    check("clearing the box disables the button again", await resetButton.isDisabled());
    // Deliberately never clicked: the button deletes every real photo, and this
    // driver runs against the same project the event does.
  } else {
    check("the reset button is absent when ALLOW_RESET is off", (await resetButton.count()) === 0);
    check("admin says why the reset is missing",
      (await page.getByText("ALLOW_RESET", { exact: false }).count()) > 0);
  }

  await page.screenshot({ path: new URL("./shots/admin-health.png", import.meta.url).pathname, fullPage: true });

  await page.getByRole("button", { name: "event", exact: true }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: new URL("./shots/admin.png", import.meta.url).pathname, fullPage: true });
  check("no uncaught page errors while driving admin", errors.length === 0, errors.join(" | "));
} finally {
  if (browser) await browser.close();
  await teardownTasks();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Admin UI");
}
