/**
 * What a scored entry was worth, as two pills: the task's own points, and what
 * the team earned on top of them.
 *
 * One number hid the achievement. A team that got five extra pigeons into a
 * 10-point photo saw "15 pts" next to a plain 15-point task and nothing said
 * they had gone beyond what was asked. The bonus pill only appears when there
 * is one, so a fixed task still reads as a single pill.
 *
 * `tone` is applied to the baseline pill (`pill-good` where an entry has been
 * approved, nothing on a neutral list) and `push` shoves the PAIR to the right
 * of a row, which a caller cannot do itself once there are two of them.
 */
export default function Score({
  base,
  bonus,
  tone = "",
  push = false,
  check = false,
}: {
  base: number;
  bonus: number;
  tone?: string;
  push?: boolean;
  /** Prefix the baseline with a tick, for a decision that has been made. */
  check?: boolean;
}) {
  return (
    <span className={`score-pills${push ? " push" : ""}`}>
      <span className={`pill ${tone}`}>
        {check ? "✓ " : ""}
        {base} pt{base === 1 ? "" : "s"}
      </span>
      {bonus > 0 && <span className="pill pill-accent">+{bonus} bonus</span>}
    </span>
  );
}
