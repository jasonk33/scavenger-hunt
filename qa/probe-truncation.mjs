/**
 * Is every name actually readable on a phone?
 *
 * Team and player names used to share one flex row, where a long team name took
 * its full content width first and left the player name whatever remained --
 * which on a 390px phone collapsed "Emerson Reid" to "E." on /submit and laid
 * the player name out at zero width on /feed and /judge. Every screen that shows
 * a name is covered here, including /, which is where the QR code lands.
 *
 * The other drivers never caught it because they assert on text CONTENT, and the
 * DOM still holds the whole name after CSS has ellipsised it away. So this probe
 * measures geometry: clientWidth is what a player can actually read.
 *
 * The assertion is simply that NO name is ever clipped, at any width. An earlier
 * version of this probe only required each name to keep a "readable" 56px, on the
 * theory that two long names cannot both fit on a narrow phone and an ellipsis is
 * the honest answer. That was the wrong bar, and it passed a build that showed a
 * real phone "The Birthday Bur... / Alex Riv...". Names now sit on separate lines
 * and wrap, so full visibility is achievable and is what gets asserted.
 *
 * The widths go far below any real device on purpose. Safari page zoom and iOS
 * larger-text settings scale the whole page, so a 390px phone with the text
 * turned up lays out like a much narrower one -- the bug report screenshot had
 * the nav bar overflowing, which reproduces here at about 300px. Testing down to
 * 260px covers that headroom.
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

// Every name above breaks at a space, so wrapping alone rescues them. A name
// with no spaces cannot wrap, and a flex item's automatic minimum size is its
// longest word -- so an unbreakable name forces its row wider than the screen
// unless the CSS also breaks mid-word. Nothing stops an organizer typing one.
const UNBROKEN_TEAM = "__qa ThePigeonIntelligenceAgencyOfManhattan";

const CASES = [
  { label: "mid    390px", team: MID_TEAM, width: 390 },
  { label: "mid    300px", team: MID_TEAM, width: 300 },
  { label: "long   390px", team: LONG_TEAM, width: 390 },
  { label: "long   320px", team: LONG_TEAM, width: 320 },
  { label: "long   300px", team: LONG_TEAM, width: 300 },
  { label: "long   260px", team: LONG_TEAM, width: 260 },
  { label: "1word  390px", team: UNBROKEN_TEAM, width: 390 },
  { label: "1word  300px", team: UNBROKEN_TEAM, width: 300 },
];

const before = await snapshot();
await teardown();
await teardownTasks();

const fx = await setup({ players: [PLAYER], teams: [LONG_TEAM, MID_TEAM, UNBROKEN_TEAM] });
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
    // The QR code points here, so it is the first thing every guest sees.
    route: "/",
    ready: ".btn-wide .pill",
    row: ".btn-wide",
    names: [
      { sel: ".btn-wide .name", what: "player name" },
      { sel: ".btn-wide .pill", what: "team name" },
    ],
  },
  {
    route: "/leaderboard",
    ready: ".card-flat .swatch",
    row: ".card-flat .row",
    names: [{ sel: ".card-flat .name", what: "team name" }],
  },
  {
    route: "/submit",
    player: true,
    ready: "header .pill-wrap",
    row: "header",
    names: [
      { sel: "header h1", what: "player name" },
      { sel: "header .pill-wrap", what: "team name" },
    ],
  },
  {
    route: "/feed",
    ready: ".card .swatch",
    row: ".cardhead",
    names: [
      { sel: ".cardhead b", what: "team name" },
      { sel: ".cardhead .byline", what: "player name" },
    ],
  },
  {
    route: "/judge",
    ready: ".card .swatch",
    row: ".cardhead",
    names: [
      { sel: ".cardhead button", what: "team name" },
      { sel: ".cardhead .byline", what: "player name" },
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

        // 1px of slack: sub-pixel text metrics round up on some glyphs even when
        // nothing is actually hidden.
        check(`${c.label} ${s.route} shows the whole ${n.what}`, e.clipped <= 1,
          `"${e.text}" clipped by ${e.clipped}px (visible ${e.w}px of ${e.natural}px)`);
      });

      note(`${c.label} ${s.route.padEnd(8)} ${s.names.map((n, i) => `${n.what}=${m.els[i]?.w ?? "?"}px`).join("  ")}`);
      await shot(page, `trunc-${s.route.slice(1)}-${c.width}-${c.team === LONG_TEAM ? "long" : "mid"}`);
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
