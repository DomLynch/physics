// Cap on simultaneous ragdolls. Pure: reads the row max_simultaneous_ragdolls from data/budget-rows.json (pass the parsed object), no clock, no state.
// The game counts its active ragdolls and asks before it creates the next one: 'ragdoll' = run physics (and cuts), 'baked' = play the baked death.
export function admit(activeCount, rows) {
  const cap = rows?.max_simultaneous_ragdolls;
  if (!Number.isInteger(cap) || cap < 1) throw new Error("budget rows: max_simultaneous_ragdolls must be an integer >= 1");
  if (!Number.isInteger(activeCount) || activeCount < 0) throw new Error("admit: activeCount must be an integer >= 0");
  return activeCount < cap ? "ragdoll" : "baked";
}
