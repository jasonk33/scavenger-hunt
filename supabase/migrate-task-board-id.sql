-- Links every task row back to its entry on the planning board.
--
-- Additive and re-runnable: adds one nullable column and one unique index, and
-- fills the column in by matching on title. Nothing is deleted and no existing
-- column is altered, so it is safe to run against the live project.
--
-- Why a column at all: `data/task-board.json` is the source of truth for task
-- content, and `npm run sync:tasks` publishes it. Matching the two sides on the
-- task text does not survive contact with an edit -- eight tasks already read
-- differently on the board than in the app -- so the board's stable id
-- (`r1-01`, `s-04`, ...) is carried on the row instead. Title matching happens
-- exactly once, here, while the two sides are still known to agree.
--
-- Secrets sit at `round: 0` on the board but `tasks.round` is
-- `check (round in (1, 2))`, so each one is listed against both rounds below
-- and ends up on two rows sharing one board_id.

alter table tasks add column if not exists board_id text;

-- Nulls are not equal to each other in a unique index, so a row that fails to
-- match below simply stays unlinked rather than blocking the migration.
create unique index if not exists tasks_round_board_id_idx
  on tasks (round, board_id);

-- Folds the punctuation that differs invisibly between the doc, the board and
-- the app: curly quotes, apostrophes, em/en dashes, and runs of whitespace.
with board (board_id, round, doc_title) as (
  values
    ('r1-01', 1, 'Re-create an album cover with the whole team'),
    ('r1-02', 1, 'Pose as statues next to a real statue — matching pose, worse execution'),
    ('r1-03', 1, 'Get a stranger to take your group photo, then get that stranger into a selfie with the team'),
    ('r1-04', 1, 'Feed a pigeon out of your hand'),
    ('r1-05', 1, 'Fit an entire hot dog in your mouth in one bite'),
    ('r1-06', 1, 'Whole team asleep in a pile on the lawn'),
    ('r1-07', 1, 'Order at a food cart using only gestures — not one word'),
    ('r1-08', 1, 'Get a pup cup from a coffee shop, for a human, and drink it at the counter'),
    ('r1-09', 1, 'Point at an empty bench and ask a stranger if they see him too — filmed over your teammate''s shoulder'),
    ('r1-10', 1, 'Sit down next to a stranger and mirror their posture exactly — photo shot from across the path'),
    ('r1-11', 1, 'Get a stranger to lend you their hat or jacket for a photo'),
    ('r1-12', 1, 'Get a stranger to let you hold their dog'),
    ('r1-13', 1, 'Kiss a teammate on the mouth in the middle of the lawn'),
    ('r1-14', 1, 'Do the worm across the lawn with people watching'),
    ('r1-15', 1, 'Shotgun a drink with a teammate'),
    ('r1-16', 1, 'Play ring around the rosie with strangers — strangers in the circle, not watching it'),
    ('r1-17', 1, 'Pose as mannequins inside a store, in among the real ones'),
    ('r1-18', 1, 'Get a stranger to sign their name on your body'),
    ('r1-19', 1, 'Get a piggyback ride from a stranger'),
    ('r1-20', 1, 'Pay for something entirely in pennies'),
    ('r1-21', 1, 'Get a stranger to feed a teammate a bite of their food'),
    ('r1-22', 1, 'Tell a stranger about the dream you had that they were in — get to the part where they are in it'),
    ('r1-23', 1, 'Swap full outfits with a teammate in the middle of the park'),
    ('r1-24', 1, 'High-five five strangers in a row without breaking stride'),
    ('r1-25', 1, 'Whole team shotguns at the same time — one photo, everyone mid-shotgun'),
    ('r1-26', 1, 'Get a stranger to do push-ups with you on the lawn'),
    ('r1-27', 1, 'Get a bench of strangers to scoot over until the entire team fits on it'),
    ('r1-28', 1, 'Put 15 t-shirts on one teammate'),
    ('r1-29', 1, 'Cover a stranger''s eyes from behind, say “guess who,” and commit until they play along'),
    ('r1-30', 1, 'Serve customers from a hot dog cart'),
    ('r1-31', 1, 'Get all the way into the fountain'),
    ('r1-32', 1, 'Trade shoes with a stranger and wear theirs for the photo'),
    ('r1-33', 1, 'Join a stranger''s picnic — the photo is you eating their food on their blanket'),
    ('r1-34', 1, 'Get a stranger to shotgun a drink with you'),
    ('r2-01', 2, 'Hug a stranger'),
    ('r2-02', 2, 'Hold hands with a stranger long enough to get the photo'),
    ('r2-03', 2, 'Alter a public sign so it reads dirty'),
    ('r2-04', 2, 'Get a barista to write something unhinged on your cup'),
    ('r2-05', 2, 'Ask a homeless person for money'),
    ('r2-06', 2, 'Try to pay for something in gum — the gum has to make it onto the counter'),
    ('r2-07', 2, 'Pretend to be a waiter until a table actually gives you their order'),
    ('r2-08', 2, 'Walk into a restaurant and ask if they sell clothes'),
    ('r2-09', 2, 'Get an old lady to flip off the camera'),
    ('r2-10', 2, 'Ask an old couple if they still poke'),
    ('r2-11', 2, 'Kiss a stranger on the cheek'),
    ('r2-12', 2, 'Scream for your mom until strangers turn around'),
    ('r2-13', 2, 'Hook up with a statue'),
    ('r2-14', 2, 'Propose to a stranger on one knee with a ring made from something off the street'),
    ('r2-15', 2, 'Stick a tampon up each nostril and keep a straight face inside a store'),
    ('r2-16', 2, 'A guy wears a thong over his clothes, out in public'),
    ('r2-17', 2, 'Put a condom over your entire head in public'),
    ('r2-18', 2, 'Blatantly smell a stranger — close enough that they notice'),
    ('r2-19', 2, 'Take a bite out of a stranger''s food'),
    ('r2-20', 2, 'Join a couple who are holding hands and hold one of their hands'),
    ('r2-21', 2, 'Stick a “kick me” sign on a stranger and photograph them walking away still wearing it'),
    ('r2-22', 2, 'Make a public scene of peeing or pooping your pants'),
    ('r2-23', 2, 'Fake a break-up loudly enough that strangers stop and stare'),
    ('r2-24', 2, 'Offer to take a stranger''s photo on their phone, then fire off a burst of selfies on it — a teammate shoots you doing it'),
    ('r2-25', 2, 'Get a crowd of strangers to sing happy birthday to Jason'),
    ('r2-26', 2, 'Blast porn audio in a cafe for ten straight seconds'),
    ('r2-27', 2, 'Get a stranger to put their number in your phone — the photo is them typing it in'),
    ('r2-28', 2, 'Get strangers to sign a petition for something insane'),
    ('r2-29', 2, 'Kiss a stranger on the lips'),
    ('r2-30', 2, 'Pick up a pigeon'),
    ('r2-31', 2, 'Form a pyramid with at least one stranger in the bottom row'),
    ('r2-32', 2, 'Carry two gallons of milk through a store, wipe out, and burst them'),
    ('r2-33', 2, 'Trade pants with a stranger'),
    ('r2-34', 2, 'Direct traffic at an intersection until cars actually react to you'),
    ('r2-35', 2, 'Get a stranger to rub cream on a teammate''s rash'),
    ('r2-36', 2, 'Get a stranger to give you the shirt off their back and wear it'),
    ('r2-37', 2, 'Get a stranger to carry a teammate bridal-style'),
    ('s-01', 1, 'Submit the worst photo of Jason'),
    ('s-01', 2, 'Submit the worst photo of Jason'),
    ('s-02', 1, 'Submit the best photo of Jason'),
    ('s-02', 2, 'Submit the best photo of Jason'),
    ('s-03', 1, 'Write and perform a four-line poem about Jason'),
    ('s-03', 2, 'Write and perform a four-line poem about Jason'),
    ('s-04', 1, 'Jason trivia'),
    ('s-04', 2, 'Jason trivia'),
    ('s-x1', 1, 'Show a stranger a photo of Jason and get them to guess his age'),
    ('s-x1', 2, 'Show a stranger a photo of Jason and get them to guess his age')
),
matched as (
  select t.id, b.board_id
  from tasks t
  join board b
    on b.round = t.round
   and lower(btrim(regexp_replace(translate(t.title,       '‘’ʼ“”—–', '''''''""--'), '\s+', ' ', 'g')))
     = lower(btrim(regexp_replace(translate(b.doc_title,   '‘’ʼ“”—–', '''''''""--'), '\s+', ' ', 'g')))
)
update tasks t
   set board_id = m.board_id
  from matched m
 where t.id = m.id
   and t.board_id is distinct from m.board_id;

-- Reports rather than fails: an unlinked row is not corruption, it just means
-- `npm run sync:tasks` will fall back to matching that one on its title.
do $$
declare unlinked int;
begin
  select count(*) into unlinked from tasks where board_id is null;
  if unlinked > 0 then
    raise notice 'tasks still unlinked after backfill: %', unlinked;
  else
    raise notice 'every task row is linked to the board';
  end if;
end $$;
