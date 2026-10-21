/**
 * Dung Abstract Argumentation Framework (AF) Implementation
 * Based on: Phan Minh Dung (1995)
 * "On the acceptability of arguments and its fundamental role in
 *  nonmonotonic reasoning, logic programming and n-person games"
 * Artificial Intelligence 77, 321-357
 *
 * 핵심 정의:
 * - AF = ⟨AR, attacks⟩ where AR is a set of arguments and attacks ⊆ AR × AR
 * - Conflict-free set: no two arguments in the set attack each other
 * - Admissible set: conflict-free + each argument is defensible
 * - Four semantics: grounded, preferred, stable, complete
 */

export interface AFArgument {
  id: string;
  content: string;
  // optional metadata
  source?: string; // e.g., Walton scheme id, xAIF node id
}

export interface AFAttack {
  attacker: string; // argument id
  target: string;   // argument id
}

export interface ArgumentationFramework {
  arguments: AFArgument[];
  attacks: AFAttack[];
}

/**
 * Def 2 (Dung p. 326): An argumentation framework is a pair
 * AF = ⟨AR, attacks⟩ where AR is a set of arguments, and attacks
 * is a binary relation on AR, i.e. attacks ⊆ AR × AR.
 */

/**
 * Def 5 (Dung p. 326): A set S of arguments is said to be conflict-free
 * if there are no arguments A and B in S such that A attacks B.
 */
function isConflictFree(set: Set<string>, af: ArgumentationFramework): boolean {
  const argArray = Array.from(set);
  for (let i = 0; i < argArray.length; i++) {
    for (let j = i + 1; j < argArray.length; j++) {
      const a = argArray[i];
      const b = argArray[j];
      if (
        af.attacks.some((att) => att.attacker === a && att.target === b) ||
        af.attacks.some((att) => att.attacker === b && att.target === a)
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Def 6.1 (Dung p. 326): An argument A ∈ AR is acceptable with respect
 * to a set S of arguments iff for each argument B ∈ AR: if B attacks A
 * then B is attacked by S.
 */
function isAcceptable(
  argId: string,
  defenderSet: Set<string>,
  af: ArgumentationFramework
): boolean {
  const attackersOfArg = af.attacks
    .filter((att) => att.target === argId)
    .map((att) => att.attacker);

  for (const attacker of attackersOfArg) {
    const isAttackerDefeated = af.attacks.some(
      (att) => defenderSet.has(att.attacker) && att.target === attacker
    );
    if (!isAttackerDefeated) {
      return false;
    }
  }
  return true;
}

/**
 * Def 6.2 (Dung p. 326): A conflict-free set of arguments S is admissible
 * iff each argument in S is acceptable with respect to S.
 */
function isAdmissible(set: Set<string>, af: ArgumentationFramework): boolean {
  if (!isConflictFree(set, af)) {
    return false;
  }
  for (const arg of set) {
    if (!isAcceptable(arg, set, af)) {
      return false;
    }
  }
  return true;
}

/**
 * Def 16 (Dung p. 329): The characteristic function, denoted by F_AF,
 * of an argumentation framework AF = ⟨AR, attacks⟩ is defined as:
 * F_AF: 2^AR → 2^AR
 * F_AF(S) = {A | A is acceptable with respect to S}
 */
function characteristicFunction(
  set: Set<string>,
  af: ArgumentationFramework
): Set<string> {
  const result = new Set<string>();
  for (const arg of af.arguments) {
    if (isAcceptable(arg.id, set, af)) {
      result.add(arg.id);
    }
  }
  return result;
}

/**
 * Def 20 (Dung p. 329): The grounded extension of an argumentation
 * framework AF, denoted by GE_AF, is the least fixed point of F_AF.
 *
 * Algorithm: Start with empty set, iteratively apply characteristic function
 * until reaching fixed point.
 */
export function groundedExtension(
  af: ArgumentationFramework
): Set<string> {
  if (af.arguments.length > 20) {
    throw new Error(
      `AF too large (${af.arguments.length} > 20 arguments). Complexity limit exceeded.`
    );
  }

  let current = new Set<string>();
  let next = characteristicFunction(current, af);

  while (next.size > current.size) {
    current = next;
    next = characteristicFunction(current, af);
  }

  return current;
}

/**
 * Def 7 (Dung p. 327): A preferred extension of an argumentation
 * framework AF is a maximal (with respect to set inclusion) admissible
 * set of AF.
 *
 * Algorithm: Generate all admissible sets and filter for maximal ones.
 */
export function preferredExtensions(
  af: ArgumentationFramework
): Array<Set<string>> {
  if (af.arguments.length > 20) {
    throw new Error(
      `AF too large (${af.arguments.length} > 20 arguments). Complexity limit exceeded.`
    );
  }

  const admissibleSets: Array<Set<string>> = [];

  // Generate all subsets and check admissibility
  const n = af.arguments.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const subset = new Set<string>();
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        subset.add(af.arguments[i].id);
      }
    }
    if (isAdmissible(subset, af)) {
      admissibleSets.push(subset);
    }
  }

  // Filter maximal sets
  const maximal: Array<Set<string>> = [];
  for (const set of admissibleSets) {
    let isMaximal = true;
    for (const other of admissibleSets) {
      if (other !== set && set.size < other.size) {
        let setIsSubset = true;
        for (const arg of set) {
          if (!other.has(arg)) {
            setIsSubset = false;
            break;
          }
        }
        if (setIsSubset) {
          isMaximal = false;
          break;
        }
      }
    }
    if (isMaximal) {
      maximal.push(set);
    }
  }

  return maximal;
}

/**
 * Def 13 (Dung p. 328): A conflict-free set of arguments S is called
 * a stable extension iff S attacks each argument which does not belong to S.
 *
 * Lemma 14 (Dung p. 328): S is a stable extension iff S = {A | A is not
 * attacked by S}.
 */
export function stableExtensions(
  af: ArgumentationFramework
): Array<Set<string>> {
  if (af.arguments.length > 20) {
    throw new Error(
      `AF too large (${af.arguments.length} > 20 arguments). Complexity limit exceeded.`
    );
  }

  const stableExts: Array<Set<string>> = [];
  const n = af.arguments.length;

  for (let mask = 0; mask < 1 << n; mask++) {
    const subset = new Set<string>();
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        subset.add(af.arguments[i].id);
      }
    }

    if (!isConflictFree(subset, af)) {
      continue;
    }

    // Check: S = {A | A is not attacked by S}
    const unattackedByS = new Set<string>();
    for (const arg of af.arguments) {
      const isAttacked = af.attacks.some(
        (att) => subset.has(att.attacker) && att.target === arg.id
      );
      if (!isAttacked) {
        unattackedByS.add(arg.id);
      }
    }

    // Check if subset equals unattackedByS
    if (
      subset.size === unattackedByS.size &&
      Array.from(subset).every((arg) => unattackedByS.has(arg))
    ) {
      stableExts.push(subset);
    }
  }

  return stableExts;
}

/**
 * Def 23 (Dung p. 329): An admissible set S of arguments is called
 * a complete extension iff each argument, which is acceptable with respect
 * to S, belongs to S.
 *
 * Lemma 24 (Dung p. 330): A conflict-free set of arguments E is a
 * complete extension iff E = F_AF(E).
 */
export function completeExtensions(
  af: ArgumentationFramework
): Array<Set<string>> {
  if (af.arguments.length > 20) {
    throw new Error(
      `AF too large (${af.arguments.length} > 20 arguments). Complexity limit exceeded.`
    );
  }

  const completeExts: Array<Set<string>> = [];
  const n = af.arguments.length;

  for (let mask = 0; mask < 1 << n; mask++) {
    const subset = new Set<string>();
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        subset.add(af.arguments[i].id);
      }
    }

    if (!isAdmissible(subset, af)) {
      continue;
    }

    // Check: E = F_AF(E)
    const fFixed = characteristicFunction(subset, af);

    if (
      subset.size === fFixed.size &&
      Array.from(subset).every((arg) => fFixed.has(arg))
    ) {
      completeExts.push(subset);
    }
  }

  return completeExts;
}

// Convenience exports for testing
export const semantics = {
  isConflictFree,
  isAcceptable,
  isAdmissible,
  characteristicFunction,
  groundedExtension,
  preferredExtensions,
  stableExtensions,
  completeExtensions,
};
