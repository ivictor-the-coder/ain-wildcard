import { analyzeExpression } from './expr';
import type { PropertyIndex } from './filter';
import type { PropertyDef } from './types';

/**
 * The dependency graph behind calculated properties.
 *
 * A formula is not an independent cell: `weighted_amount` reads `probability`,
 * and a "commission" formula reads `weighted_amount`. Evaluating them in the
 * order the property table happens to return is how a save writes a value that
 * belongs to the *previous* save — and because calculated values are persisted
 * on the row, every list, filter, report and workflow trigger then reads the
 * stale number. So formulas are sorted here, once per schema version, and
 * evaluated inputs-first; and a formula that would close a loop is refused at
 * definition time rather than left to oscillate on every write.
 */

/** The properties a formula reads. Never throws: a stored formula is validated. */
export function formulaReferences(expression: string): string[] {
  try { return analyzeExpression(expression).properties; }
  catch { return []; }
}

export interface CalculationPlan {
  /**
   * Rollup properties, evaluated before any formula. A rollup reads the
   * records on the other end of an association and nothing on this record, so
   * it is always a source in the graph — and putting it first is what lets a
   * formula read `total_open_deal_value` and get this save's number.
   */
  rollups: PropertyDef[];
  /** Calculated properties, inputs before readers. Evaluate in this order. */
  order: PropertyDef[];
  /**
   * Calculated properties that sit on a cycle. Definition-time validation
   * refuses to create one, so this is only ever non-empty for a formula that
   * pre-dates the check — and those are skipped rather than evaluated, because
   * a cycle has no fixed point and "evaluate once anyway" turns every save,
   * including a save that changes nothing, into a permanent mutation.
   */
  cyclic: string[];
  /** For each calculated property, the calculated properties it reads. */
  dependsOn: Map<string, string[]>;
  /** For each property, the calculated properties that read it. */
  usedBy: Map<string, string[]>;
}

const plans = new WeakMap<PropertyIndex, CalculationPlan>();

/**
 * Sort an object type's formulas into evaluation order. Cached against the
 * property index itself, so it is rebuilt exactly when the schema cache is.
 */
export function calculationPlan(index: PropertyIndex): CalculationPlan {
  const cached = plans.get(index);
  if (cached) return cached;

  // Display order is the tiebreak, so two formulas that do not depend on one
  // another always evaluate in the same order on every machine and every save.
  const byDisplay = (a: PropertyDef, b: PropertyDef): number =>
    a.position - b.position || a.name.localeCompare(b.name);
  const calculated = [...index.values()].filter((p) => !!p.calculated).sort(byDisplay);
  const rollups = [...index.values()].filter((p) => !!p.rollup && !p.calculated).sort(byDisplay);
  const isCalculated = new Set(calculated.map((p) => p.name));

  const dependsOn = new Map<string, string[]>();
  const usedBy = new Map<string, string[]>();
  for (const prop of calculated) {
    const refs = formulaReferences(prop.calculated ?? '').filter((r) => r !== prop.name);
    dependsOn.set(prop.name, refs);
    for (const ref of refs) {
      const readers = usedBy.get(ref);
      if (readers) readers.push(prop.name); else usedBy.set(ref, [prop.name]);
    }
  }

  // Kahn's algorithm over the calculated-to-calculated edges only: a formula
  // reading a plain property has nothing to wait for.
  const indegree = new Map<string, number>();
  for (const prop of calculated) {
    indegree.set(prop.name, dependsOn.get(prop.name)!.filter((r) => isCalculated.has(r)).length);
  }
  const ready = calculated.filter((p) => indegree.get(p.name) === 0);
  const order: PropertyDef[] = [];
  while (ready.length) {
    const prop = ready.shift()!;
    order.push(prop);
    for (const reader of usedBy.get(prop.name) ?? []) {
      const left = (indegree.get(reader) ?? 0) - 1;
      indegree.set(reader, left);
      if (left === 0) {
        const next = index.get(reader);
        if (next) ready.push(next);
      }
    }
  }

  const ordered = new Set(order.map((p) => p.name));
  const plan: CalculationPlan = {
    rollups,
    order,
    cyclic: calculated.filter((p) => !ordered.has(p.name)).map((p) => p.name),
    dependsOn,
    usedBy,
  };
  plans.set(index, plan);
  return plan;
}

/**
 * Would `expression`, saved as the formula for `name`, close a loop? Returns
 * the chain that proves it — `cyc_a → cyc_b → cyc_a` — so the error can name
 * the cycle instead of asserting one exists.
 */
export function formulaCycle(index: PropertyIndex, name: string, expression: string): string[] | null {
  const formulaOf = (prop: string): string | null =>
    prop === name ? expression : (index.get(prop)?.calculated ?? null);
  const path: string[] = [];
  const visited = new Set<string>([name]);

  const walk = (prop: string): string[] | null => {
    const formula = formulaOf(prop);
    if (!formula) return null;
    path.push(prop);
    for (const ref of formulaReferences(formula)) {
      if (ref === name) return [...path, name];
      if (visited.has(ref)) continue;
      visited.add(ref);
      const found = walk(ref);
      if (found) return found;
    }
    path.pop();
    return null;
  };

  return walk(name);
}
