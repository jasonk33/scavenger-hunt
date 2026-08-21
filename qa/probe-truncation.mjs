/**
 * Is every name actually readable on a phone?
 *
 * Three screens lay a team name and a player name out on one flex row. A long
 * team name used to take its full content width first and leave the player name
 * whatever was left -- which on a 390px phone collapsed "Emerson Reid" to "E."
 * on /submit and rendered the player name at zero width on /feed and /judge.
 *
 * The other drivers never caught it because they assert on text CONTENT, and the
 * DOM still holds the whole name after CSS has ellipsised it away. So this probe
 * measures geometry: clientWidth is what a player can actually read.
 *
 * "Nothing is ever clipped" is not an achievable invariant -- a 30-character team
 * name and a 13-character player name genuinely do not both fit on a 320px
 * phone, and an ellipsis is the right answer there. So each name declares how
 * much of itself has to survive:
 *
 *   whole     never clipped at any width. Only the player's own name on
 *             /submit, which is how they check they picked the right person --
 *             it gets its own line and wraps rather than truncating, so this
 *             holds however long a name gets.
 *   readable  may ellipsise once space runs out, but must never be squeezed
 *             below a legible width by the name next to it.
 *
 * Widths are real devices, not round numbers: 390 is an iPhone 14/15, 360 a
 * common Android, and 320 is what an iPhone reports with Display Zoom on --
 * which is also the closest thing to the enlarged text in the bug report.
 */
import { chromium } from "@playwright/test";
import {
  BASE, asOrganizer, asPlayer, setup, teardown, teardownTasks, call, check, note, summary,
  snapshot, seed, shot, admin,
} from "./lib.mjs";

// At least as long as the longest real names ("The Pigeon Intelligence Agency",
// 30 chars, and "Quinn Barrett", 13), so a fix that only just fits today does
// not quietly stop fitting when someone is renamed on the day.
const LONG_TEAM = "__qa The Pigeon Intelligence Agency";
const MID_TEAM = "__qa The Birthday Bureau";
const PLAYER = "__qa Quinn Barrett";

// Below this a name is not a name any more -- roughly seven characters.
const FLOOR_PX = 56;

const CASES = [
  { label: "typical 390px", team: MID_TEAM, width: 390, typical: true },
  { label: "worst   390px", team: LONG_TEAM, width: 390, typical: false },
  { label: "worst   360px", team: LONG_TEAM, width: 360, typical: false },
  { label: "worst   320px", team: LONG_TEAM, width: 320, typical: false },
];

const before = await snapshot();
await teardown();
await teardownTasks();

const fx = await setup({ players: [PLAYER], teams: [LONG_TEAM, MID_TEAM] });
const player = fx.player(PLAYER);

const task = await call("/api/admin/tasks", {
  method: "POST",
  body: JSON.stringify({ round: 1, title: "__qa Truncation task", points: 10 }),
});
if (task.status !== 200) throw new Error(`task create failed: ${JSON.stringify(task.body)}`);
const taskId = task.body.id;

/** Puts the player on `team` for round 1, then re-seeds this round's submissions. */
async function putOnTeam(teamName) {
  await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({
      round: 1,
      entries: [{ playerId: player.id, teamId: fx.teamOf(teamName, 1).id }],
    }),
  });
  // team_id is denormalized onto a submission at insert, so the rows have to be
  // recreated after a roster change rather than reused.
  await admin.from("submissions").delete().eq("player_id", player.id);
  await seed({ playerId: player.id, taskId });
  const approved = await seed({ playerId: player.id, taskId, name: "photo-2.jpg" });
  await admin.from("submissions").update({ status: "approved" }).eq("id", approved);
}

/**
 * Each screen: how to know its data has arrived (measuring before that is how a
 * previous version of this probe measured an empty header and passed), and every
 * element that carries a name.
 */
const SCREENS = [
  {
    route: "/submit",
    player: true,
    ready: "header .pill.name",
    row: "header",
    names: [
      { sel: "header h1", what: "player name", show: "whole" },
      { sel: "header .pill.name", what: "team name", show: "readable" },
    ],
  },
  {
    route: "/feed",
    ready: ".card .swatch",
    row: ".card .row",
    names: [
      { sel: ".card .row b.name", what: "team name", show: "readable" },
      { sel: ".card .row span.name", what: "player name", show: "readable" },
    ],
  },
  {
    route: "/judge",
    organizer: true,
    ready: ".card .swatch",
    row: ".card .row",
    names: [
      { sel: ".card .row button.name", what: "team name", show: "readable" },
      { sel: ".card .row span.name", what: "player name", show: "readable" },
    ],
  },
];

const browser = await chromium.launch();
try {
  let current = null;
  for (const c of CASES) {
    if (c.team !== current) { await putOnTeam(c.team); current = c.team; }

    for (const s of SCREENS) {
      const ctx = await browser.newContext({ viewport: { width: c.width, height: 844 } });
      await asOrganizer(ctx);
      if (s.player) await asPlayer(ctx, player);
      const page = await ctx.newPage();
      await page.goto(`${BASE}${s.route}`);

      const shown = await page.waitForSelector(s.ready, { timeout: 30000 }).then(() => true).catch(() => false);
      check(`${c.label} ${s.route} renders its name row`, shown);
      if (!shown) { await shot(page, `trunc-${s.route.slice(1)}-${c.width}-missing`); await ctx.close(); continue; }

      const m = await page.evaluate(({ names, row }) => {
        const r = document.querySelector(row);
        return {
          // The page-level check: a card that refuses to shrink inside its grid
          // track scrolls the whole document sideways while every row inside it
          // still measures as fitting.
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          rowOverflow: r ? r.scrollWidth - r.clientWidth : 0,
          els: names.map((n) => {
            const el = document.querySelector(n.sel);
            if (!el) return null;
            return {
              clipped: el.scrollWidth - el.clientWidth,
              natural: el.scrollWidth,
              w: el.clientWidth,
              text: el.innerText.trim(),
            };
          }),
        };
      }, { names: s.names, row: s.row });

      // Anything that scrolls sideways on a phone is a bug regardless of tier.
      check(`${c.label} ${s.route} page does not scroll sideways`, m.pageOverflow <= 1,
        `document is ${m.pageOverflow}px wider than the viewport`);
      check(`${c.label} ${s.route} row does not overflow`, m.rowOverflow <= 1,
        `row scrolls ${m.rowOverflow}px past its box`);

      s.names.forEach((n, i) => {
        const e = m.els[i];
        if (!e) { check(`${c.label} ${s.route} has a ${n.what}`, false, `no element for ${n.sel}`); return; }

        if (n.show === "whole") {
          // 1px of slack: sub-pixel text metrics round up on some glyphs even
          // when nothing is actually hidden.
          check(`${c.label} ${s.route} shows the whole ${n.what}`, e.clipped <= 1,
            `"${e.text}" clipped by ${e.clipped}px (visible ${e.w}px of ${e.natural}px)`);
        } else {
          check(`${c.label} ${s.route} keeps the ${n.what} readable`,
            e.w >= Math.min(e.natural, FLOOR_PX),
            `"${e.text}" is only ${e.w}px wide (needs ${e.natural}px) -- starved by the other name`);
        }
      });

      note(`${c.label} ${s.route.padEnd(8)} ${s.names.map((n, i) => `${n.what}=${m.els[i]?.w ?? "?"}px`).join("  ")}`);
      await shot(page, `trunc-${s.route.slice(1)}-${c.width}-${c.typical ? "typical" : "worst"}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await teardown();
  await teardownTasks();
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Name truncation");
}
