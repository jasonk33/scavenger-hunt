/**
 * Initial task board, transcribed from the planning doc
 * (docs.google.com/document/d/1p3yndSy3mD1OzgYYuJ9ni-Cfv0h9R1qp5pI0N2p7iac).
 *
 * `docTitle` is the doc's exact wording and never changes here — it is the join
 * key for reconciling edits back to the doc and to the Supabase `tasks` table.
 * `title` starts equal to it and is what gets edited in the canvas.
 *
 * Ratings are a first pass meant to be argued with, not trusted. Each is 1-5:
 *   difficulty  how hard the thing is to actually pull off
 *   guts        social courage required to start it
 *   luck        dependence on finding the right target or opportunity
 *   payoff      how funny/good the resulting photo or clip is
 *   risk        chance of real trouble: thrown out, ticketed, someone upset
 *
 * difficulty/guts/luck drive the suggested point tier. payoff and risk do not —
 * they are the keep/cut axes.
 */

/** @param {number} round @param {string} n */
const id = (round, n) => `${round === 0 ? "s" : `r${round}`}-${String(n).padStart(2, "0")}`;

let counters = { 0: 0, 1: 0, 2: 0 };

/**
 * @param {number} round 0 = secret challenge
 * @param {number} points tier assigned in the doc
 * @param {string} docTitle
 * @param {object} r ratings + flags
 */
function t(round, points, docTitle, r) {
  const n = ++counters[round];
  return {
    id: id(round, n),
    round,
    docTitle,
    title: docTitle,
    points,
    docOrder: n,
    difficulty: r.d,
    guts: r.g,
    luck: r.l,
    payoff: r.p,
    risk: r.r,
    needsClip: r.clip ?? false,
    prop: r.prop ?? "",
    status: r.cut ? "cut" : "keep",
    rewrite: false,
    note: r.note ?? "",
  };
}

export const SEED_TASKS = [
  // ── Round 1 — Madison Square Park ─────────────────────────────────────────
  t(1, 1, "Re-create an album cover with the whole team", { d: 2, g: 1, l: 1, p: 3, r: 1 }),
  t(1, 1, "Pose as statues next to a real statue — matching pose, worse execution", { d: 1, g: 2, l: 1, p: 3, r: 1 }),
  t(1, 1, "Get a stranger to take your group photo, then get that stranger into a selfie with the team", { d: 2, g: 2, l: 1, p: 2, r: 1 }),
  t(1, 1, "Feed a pigeon out of your hand", { d: 3, g: 1, l: 3, p: 3, r: 1, note: "Pigeons don't cooperate on demand — high variance for a 1-pointer." }),
  t(1, 1, "Fit an entire hot dog in your mouth in one bite", { d: 3, g: 2, l: 1, p: 4, r: 2, prop: "hot dog (buy)" }),
  t(1, 1, "Whole team asleep in a pile on the lawn", { d: 1, g: 2, l: 1, p: 3, r: 1 }),

  t(1, 3, "Order at a food cart using only gestures — not one word", { d: 3, g: 3, l: 1, p: 3, r: 1, clip: true }),
  t(1, 3, "Get a pup cup from a coffee shop, for a human, and drink it at the counter", { d: 2, g: 3, l: 2, p: 3, r: 1 }),
  t(1, 3, "Point at an empty bench and ask a stranger if they see him too — filmed over your teammate's shoulder", { d: 2, g: 4, l: 1, p: 4, r: 1, clip: true }),
  t(1, 3, "Sit down next to a stranger and mirror their posture exactly — photo shot from across the path", { d: 2, g: 3, l: 2, p: 3, r: 1 }),
  t(1, 3, "Get a stranger to lend you their hat or jacket for a photo", { d: 3, g: 3, l: 2, p: 3, r: 1 }),
  t(1, 3, "Get a stranger to let you hold their dog", { d: 3, g: 3, l: 3, p: 3, r: 1 }),
  t(1, 3, "Kiss a teammate on the mouth in the middle of the lawn", { d: 2, g: 4, l: 1, p: 3, r: 1 }),
  t(1, 3, "Do the worm across the lawn with people watching", { d: 3, g: 3, l: 1, p: 4, r: 1, clip: true }),
  t(1, 3, "Shotgun a drink with a teammate", { d: 2, g: 3, l: 1, p: 3, r: 3, prop: "cans", note: "Open container in a NYC park is a real ticket. Three tasks on the list are shotguns." }),

  t(1, 5, "Play ring around the rosie with strangers — strangers in the circle, not watching it", { d: 4, g: 4, l: 3, p: 4, r: 1 }),
  t(1, 5, "Pose as mannequins inside a store, in among the real ones", { d: 3, g: 3, l: 3, p: 4, r: 2 }),
  t(1, 5, "Get a stranger to sign their name on your body", { d: 3, g: 4, l: 2, p: 3, r: 1, prop: "marker" }),
  t(1, 5, "Get a piggyback ride from a stranger", { d: 4, g: 4, l: 3, p: 4, r: 2 }),
  t(1, 5, "Pay for something entirely in pennies", { d: 3, g: 3, l: 2, p: 3, r: 1, prop: "roll of pennies" }),
  t(1, 5, "Get a stranger to feed a teammate a bite of their food", { d: 4, g: 4, l: 3, p: 4, r: 1 }),
  t(1, 5, "Tell a stranger about the dream you had that they were in — get to the part where they are in it", { d: 3, g: 4, l: 2, p: 4, r: 1, clip: true }),
  t(1, 5, "Swap full outfits with a teammate in the middle of the park", { d: 3, g: 4, l: 1, p: 4, r: 2 }),
  t(1, 5, "High-five five strangers in a row without breaking stride", { d: 4, g: 3, l: 3, p: 3, r: 1, clip: true }),
  t(1, 5, "Whole team shotguns at the same time — one photo, everyone mid-shotgun", { d: 2, g: 3, l: 1, p: 3, r: 3, prop: "cans", note: "Third shotgun task. Overlaps heavily with the teammate shotgun." }),
  t(1, 5, "Get a stranger to do push-ups with you on the lawn", { d: 4, g: 4, l: 3, p: 4, r: 1 }),
  t(1, 5, "Get a bench of strangers to scoot over until the entire team fits on it", { d: 4, g: 4, l: 3, p: 4, r: 1 }),

  t(1, 10, "Put 15 t-shirts on one teammate", { d: 3, g: 1, l: 1, p: 4, r: 1, prop: "15 t-shirts", note: "Pure logistics — no stranger, no nerve, no luck. Priced like the hardest tier but isn't." }),
  t(1, 10, "Cover a stranger's eyes from behind, say “guess who,” and commit until they play along", { d: 4, g: 5, l: 3, p: 4, r: 3, cut: true, note: "Struck through in the doc." }),
  t(1, 10, "Serve customers from a hot dog cart", { d: 5, g: 5, l: 4, p: 5, r: 3 }),
  t(1, 10, "Get all the way into the fountain", { d: 3, g: 4, l: 1, p: 5, r: 4, note: "Park rangers / NYPD. Also wet for the remaining 3 hours of daylight." }),
  t(1, 10, "Trade shoes with a stranger and wear theirs for the photo", { d: 5, g: 5, l: 4, p: 4, r: 1 }),
  t(1, 10, "Join a stranger's picnic — the photo is you eating their food on their blanket", { d: 5, g: 5, l: 4, p: 5, r: 1 }),
  t(1, 10, "Get a stranger to shotgun a drink with you", { d: 5, g: 5, l: 4, p: 4, r: 3, prop: "cans" }),

  // ── Round 2 — NoMad and Flatiron ──────────────────────────────────────────
  t(2, 1, "Hug a stranger", { d: 2, g: 3, l: 2, p: 2, r: 1 }),
  t(2, 1, "Hold hands with a stranger long enough to get the photo", { d: 3, g: 3, l: 2, p: 3, r: 1 }),
  t(2, 1, "Alter a public sign so it reads dirty", { d: 2, g: 2, l: 2, p: 3, r: 3, prop: "marker", note: "This is defacing property. Cheapest tier on the list for the highest legal exposure in Round 2." }),
  t(2, 1, "Get a barista to write something unhinged on your cup", { d: 2, g: 2, l: 2, p: 3, r: 1 }),

  t(2, 3, "Ask a homeless person for money", { d: 2, g: 3, l: 2, p: 2, r: 2, clip: true, note: "Punches down, and it's the one task on the list that looks bad on camera to anyone who wasn't there. Lowest payoff in its tier." }),
  t(2, 3, "Try to pay for something in gum — the gum has to make it onto the counter", { d: 2, g: 3, l: 1, p: 3, r: 1, prop: "gum" }),
  t(2, 3, "Pretend to be a waiter until a table actually gives you their order", { d: 4, g: 4, l: 3, p: 5, r: 3, clip: true, note: "Priced at 3 but it's the hardest ask in the tier by a distance." }),
  t(2, 3, "Walk into a restaurant and ask if they sell clothes", { d: 1, g: 2, l: 1, p: 3, r: 1, clip: true }),
  t(2, 3, "Get an old lady to flip off the camera", { d: 4, g: 4, l: 4, p: 5, r: 1 }),
  t(2, 3, "Ask an old couple if they still poke", { d: 3, g: 4, l: 4, p: 3, r: 2, clip: true }),
  t(2, 3, "Kiss a stranger on the cheek", { d: 3, g: 4, l: 2, p: 3, r: 2 }),
  t(2, 3, "Scream for your mom until strangers turn around", { d: 1, g: 4, l: 1, p: 3, r: 1, clip: true }),
  t(2, 3, "Hook up with a statue", { d: 1, g: 3, l: 1, p: 3, r: 2 }),
  t(2, 3, "Propose to a stranger on one knee with a ring made from something off the street", { d: 3, g: 4, l: 2, p: 4, r: 1 }),
  t(2, 3, "Stick a tampon up each nostril and keep a straight face inside a store", { d: 2, g: 4, l: 1, p: 4, r: 2, prop: "tampons" }),
  t(2, 3, "A guy wears a thong over his clothes, out in public", { d: 2, g: 4, l: 1, p: 4, r: 2, prop: "thong" }),
  t(2, 3, "Put a condom over your entire head in public", { d: 3, g: 4, l: 1, p: 4, r: 2, prop: "condoms" }),

  t(2, 5, "Blatantly smell a stranger — close enough that they notice", { d: 3, g: 4, l: 2, p: 3, r: 2 }),
  t(2, 5, "Take a bite out of a stranger's food", { d: 5, g: 5, l: 3, p: 4, r: 3, note: "Overlaps with R1's 'get a stranger to feed a teammate' but this version is taking, not being offered — much likelier to genuinely anger someone." }),
  t(2, 5, "Join a couple who are holding hands and hold one of their hands", { d: 4, g: 5, l: 3, p: 5, r: 2 }),
  t(2, 5, "Stick a “kick me” sign on a stranger and photograph them walking away still wearing it", { d: 4, g: 4, l: 3, p: 4, r: 2, prop: "marker and paper" }),
  t(2, 5, "Make a public scene of peeing or pooping your pants", { d: 2, g: 5, l: 1, p: 3, r: 2, clip: true }),
  t(2, 5, "Fake a break-up loudly enough that strangers stop and stare", { d: 3, g: 4, l: 1, p: 4, r: 1, clip: true }),
  t(2, 5, "Offer to take a stranger's photo on their phone, then fire off a burst of selfies on it — a teammate shoots you doing it", { d: 3, g: 3, l: 2, p: 5, r: 1 }),
  t(2, 5, "Get a crowd of strangers to sing happy birthday to Jason", { d: 4, g: 4, l: 3, p: 5, r: 1 }),
  t(2, 5, "Blast porn audio in a cafe for ten straight seconds", { d: 2, g: 4, l: 1, p: 3, r: 4, clip: true, note: "Easy to do, high chance of being thrown out, and the bystanders didn't opt in. Worst risk-to-payoff ratio on the board." }),
  t(2, 5, "Get a stranger to put their number in your phone — the photo is them typing it in", { d: 4, g: 4, l: 3, p: 3, r: 1 }),
  t(2, 5, "Get strangers to sign a petition for something insane", { d: 3, g: 3, l: 2, p: 4, r: 1, prop: "paper" }),

  t(2, 10, "Kiss a stranger on the lips", { d: 5, g: 5, l: 4, p: 4, r: 4, note: "The one task where a wrong read is a genuine problem, not a funny story." }),
  t(2, 10, "Pick up a pigeon", { d: 5, g: 2, l: 5, p: 5, r: 2, note: "Effectively unachievable — this is a lottery ticket, not a task." }),
  t(2, 10, "Form a pyramid with at least one stranger in the bottom row", { d: 5, g: 4, l: 4, p: 5, r: 2 }),
  t(2, 10, "Carry two gallons of milk through a store, wipe out, and burst them", { d: 3, g: 4, l: 1, p: 5, r: 4, cut: true, note: "Struck through in the doc." }),
  t(2, 10, "Trade pants with a stranger", { d: 5, g: 5, l: 4, p: 5, r: 3 }),
  t(2, 10, "Direct traffic at an intersection until cars actually react to you", { d: 3, g: 5, l: 2, p: 4, r: 5, clip: true, note: "Only task on the board that can get someone hit by a car." }),
  t(2, 10, "Get a stranger to rub cream on a teammate's rash", { d: 5, g: 5, l: 4, p: 5, r: 2, prop: "cream" }),
  t(2, 10, "Get a stranger to give you the shirt off their back and wear it", { d: 5, g: 5, l: 4, p: 4, r: 2, note: "Near-duplicate of R1's 'trade shoes' and R2's 'trade pants' — three variations on 'get a stranger's clothing'." }),
  t(2, 10, "Get a stranger to carry a teammate bridal-style", { d: 5, g: 5, l: 4, p: 5, r: 2 }),

  // ── Birthday secret challenges (7 points, handed out mid-round) ────────────
  t(0, 7, "Submit the worst photo of Jason", { d: 1, g: 1, l: 2, p: 4, r: 1 }),
  t(0, 7, "Submit the best photo of Jason", { d: 1, g: 1, l: 2, p: 3, r: 1 }),
  t(0, 7, "Write and perform a four-line poem about Jason", { d: 2, g: 2, l: 1, p: 4, r: 1 }),
  t(0, 7, "Jason trivia", { d: 2, g: 1, l: 1, p: 2, r: 1, note: "Not a task yet — it's a category. Needs actual questions and a way to score them." }),
];

/**
 * Defaults for the tier model. Editable in the canvas and persisted with the board.
 *
 * The thresholds are fitted, not invented: they're the score cutoffs that
 * reproduce the doc's own tier distribution (10/22/23/14) across the tasks it
 * already has. That matters — arbitrary cutoffs would flag half the board and
 * the disagreements would be noise. Fitted, ~1 in 3 tasks disagrees, and each
 * one is a real argument about whether the doc priced it right.
 */
export const DEFAULT_MODEL = {
  weights: { difficulty: 1.2, guts: 1.0, luck: 0.6 },
  // Upper bound of each tier's weighted score. Anything above `t5` is a 10.
  thresholds: { t1: 5.9, t3: 8.1, t5: 10.8 },
};

export const ROUND_LABELS = {
  0: "Secret",
  1: "Round 1 · Madison Square Park",
  2: "Round 2 · NoMad & Flatiron",
};
