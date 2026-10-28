// Body -> shape lookup (data/shape-maps/body-shapes.json). Throws on an unknown or excluded body id instead of returning undefined.
//   import lookup from "@frankendom/physics/data/shape-maps/body-shapes.json" with { type: "json" };
//   const { shape, height_m, girth, mass_kg, unclamped_mass_kg } = bodyShape(lookup, "mon-0056");
// Radius = map.r * height_m * girth. mass_kg is capped at the role table's 140 kg; use unclamped_mass_kg to scale impulses.
export function bodyShape(lookup, id) {
  if (Object.hasOwn(lookup.excluded, id)) throw new Error(`excluded body "${id}": ${lookup.excluded[id]}`);
  if (!Object.hasOwn(lookup.bodies, id)) throw new Error(`unknown body "${id}": not in the shape lookup (106-rig bodies only)`);
  const [s, hmm, g100, kg10, ukg10] = lookup.bodies[id];
  return { shape: lookup.shapes[s], height_m: hmm / 1000, girth: g100 / 100, mass_kg: kg10 / 10, unclamped_mass_kg: ukg10 / 10 };
}
