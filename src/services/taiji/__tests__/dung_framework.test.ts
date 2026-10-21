/**
 * Unit tests for Dung Abstract Argumentation Framework
 * Based on examples from Dung (1995)
 */

import {
  ArgumentationFramework,
  groundedExtension,
  preferredExtensions,
  stableExtensions,
  completeExtensions,
  semantics,
} from '../dung_framework';

describe('Dung Abstract Argumentation Framework', () => {
  /**
   * Example 3 (Dung p. 326): Example 1 continued.
   * AR = {i₁, i₂, a}
   * attacks = {(i₁, a), (a, i₁), (i₂, a)}
   *
   * Expected:
   * - Grounded extension: {i₁, i₂}
   * - Preferred extension: {i₁, i₂}
   * - Stable extension: {i₁, i₂}
   */
  test('Example 3: Government negotiation dispute', () => {
    const af: ArgumentationFramework = {
      arguments: [
        { id: 'i1', content: 'My government cannot negotiate' },
        { id: 'i2', content: 'But your government is terrorist' },
        { id: 'a', content: 'Your government does not recognize ours' },
      ],
      attacks: [
        { attacker: 'i1', target: 'a' },
        { attacker: 'a', target: 'i1' },
        { attacker: 'i2', target: 'a' },
      ],
    };

    const grounded = groundedExtension(af);
    expect(grounded.size).toBe(2);
    expect(grounded.has('i1')).toBe(true);
    expect(grounded.has('i2')).toBe(true);
    expect(grounded.has('a')).toBe(false);

    const preferred = preferredExtensions(af);
    expect(preferred.length).toBe(1);
    expect(preferred[0].has('i1')).toBe(true);
    expect(preferred[0].has('i2')).toBe(true);

    const stable = stableExtensions(af);
    expect(stable.length).toBe(1);
    expect(stable[0].has('i1')).toBe(true);
    expect(stable[0].has('i2')).toBe(true);
  });

  /**
   * Example 9 (Dung p. 327): Nixon diamond.
   * AR = {A, B}
   * A: "Nixon is anti-pacifist since he is a republican"
   * B: "Nixon is a pacifist since he is a quaker"
   * attacks = {(A, B), (B, A)}
   *
   * Expected:
   * - Grounded extension: ∅ (empty, skeptical)
   * - Preferred extensions: {A}, {B} (two credulous options)
   * - Stable extensions: {A}, {B}
   * - Complete extensions: {∅}, {A}, {B}
   */
  test('Example 9: Nixon diamond', () => {
    const af: ArgumentationFramework = {
      arguments: [
        { id: 'A', content: 'Nixon is anti-pacifist (republican)' },
        { id: 'B', content: 'Nixon is pacifist (quaker)' },
      ],
      attacks: [
        { attacker: 'A', target: 'B' },
        { attacker: 'B', target: 'A' },
      ],
    };

    // Grounded: empty set
    const grounded = groundedExtension(af);
    expect(grounded.size).toBe(0);

    // Preferred: two extensions {A} and {B}
    const preferred = preferredExtensions(af);
    expect(preferred.length).toBe(2);
    const hasA = preferred.some((ext) => ext.has('A') && !ext.has('B'));
    const hasB = preferred.some((ext) => ext.has('B') && !ext.has('A'));
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);

    // Stable: same as preferred for this framework
    const stable = stableExtensions(af);
    expect(stable.length).toBe(2);

    // Complete: includes empty set plus preferred
    const complete = completeExtensions(af);
    expect(complete.length).toBeGreaterThanOrEqual(2);
    const hasEmpty = complete.some((ext) => ext.size === 0);
    expect(hasEmpty).toBe(true);
  });

  /**
   * Simple test: Single argument with no attacks
   * AR = {A}
   * attacks = ∅
   *
   * Expected:
   * - All extensions: {A}
   */
  test('Single argument with no attacks', () => {
    const af: ArgumentationFramework = {
      arguments: [{ id: 'A', content: 'Simple claim' }],
      attacks: [],
    };

    const grounded = groundedExtension(af);
    expect(grounded.size).toBe(1);
    expect(grounded.has('A')).toBe(true);

    const preferred = preferredExtensions(af);
    expect(preferred.length).toBe(1);
    expect(preferred[0].has('A')).toBe(true);

    const stable = stableExtensions(af);
    expect(stable.length).toBe(1);
    expect(stable[0].has('A')).toBe(true);
  });

  /**
   * Empty framework: No arguments, no attacks
   * AR = ∅
   * attacks = ∅
   *
   * Expected:
   * - All extensions: ∅ (empty set)
   */
  test('Empty argumentation framework', () => {
    const af: ArgumentationFramework = {
      arguments: [],
      attacks: [],
    };

    const grounded = groundedExtension(af);
    expect(grounded.size).toBe(0);

    const preferred = preferredExtensions(af);
    expect(preferred.length).toBe(1);
    expect(preferred[0].size).toBe(0);

    const stable = stableExtensions(af);
    expect(stable.length).toBe(1);
    expect(stable[0].size).toBe(0);
  });

  /**
   * Chain of attacks: A attacks B attacks C
   * AR = {A, B, C}
   * attacks = {(A, B), (B, C)}
   *
   * Expected:
   * - Grounded: {A, C}
   * - Preferred: {A, C}
   * - Stable: {A, C}
   */
  test('Chain of attacks: A→B→C', () => {
    const af: ArgumentationFramework = {
      arguments: [
        { id: 'A', content: 'Claim A' },
        { id: 'B', content: 'Claim B' },
        { id: 'C', content: 'Claim C' },
      ],
      attacks: [
        { attacker: 'A', target: 'B' },
        { attacker: 'B', target: 'C' },
      ],
    };

    const grounded = groundedExtension(af);
    expect(grounded.has('A')).toBe(true);
    expect(grounded.has('B')).toBe(false);
    expect(grounded.has('C')).toBe(true);

    const preferred = preferredExtensions(af);
    expect(preferred.length).toBe(1);
    expect(preferred[0].has('A')).toBe(true);
    expect(preferred[0].has('C')).toBe(true);

    const stable = stableExtensions(af);
    expect(stable.length).toBe(1);
    expect(stable[0].has('A')).toBe(true);
    expect(stable[0].has('C')).toBe(true);
  });

  /**
   * Self-defeating argument: A attacks A
   * AR = {A, B}
   * attacks = {(A, A), (A, B)}
   *
   * Expected:
   * - Grounded: ∅
   * - Preferred: {B} (not {A} because A attacks itself)
   * - Stable: {B}
   */
  test('Self-defeating argument: A attacks itself', () => {
    const af: ArgumentationFramework = {
      arguments: [
        { id: 'A', content: 'Claim A' },
        { id: 'B', content: 'Claim B' },
      ],
      attacks: [
        { attacker: 'A', target: 'A' },
        { attacker: 'A', target: 'B' },
      ],
    };

    const grounded = groundedExtension(af);
    expect(grounded.size).toBe(0);

    const preferred = preferredExtensions(af);
    const hasOnlyB = preferred.some((ext) => ext.has('B') && !ext.has('A'));
    expect(hasOnlyB).toBe(true);

    const stable = stableExtensions(af);
    const stableHasB = stable.some((ext) => ext.has('B'));
    expect(stableHasB).toBe(true);
  });

  /**
   * Test conflict-free property
   */
  test('Conflict-free set detection', () => {
    const af: ArgumentationFramework = {
      arguments: [
        { id: 'A', content: 'Claim A' },
        { id: 'B', content: 'Claim B' },
      ],
      attacks: [{ attacker: 'A', target: 'B' }],
    };

    const conflictFreeSet = new Set(['A']);
    expect(semantics.isConflictFree(conflictFreeSet, af)).toBe(true);

    const nonConflictFreeSet = new Set(['A', 'B']);
    expect(semantics.isConflictFree(nonConflictFreeSet, af)).toBe(false);
  });

  /**
   * Test acceptability of arguments
   */
  test('Acceptability of arguments', () => {
    const af: ArgumentationFramework = {
      arguments: [
        { id: 'A', content: 'Claim A' },
        { id: 'B', content: 'Claim B' },
        { id: 'C', content: 'Claim C' },
      ],
      attacks: [
        { attacker: 'B', target: 'A' },
        { attacker: 'C', target: 'B' },
      ],
    };

    // A is acceptable with respect to {C} because C attacks B (the attacker of A)
    const defenderSet = new Set(['C']);
    expect(semantics.isAcceptable('A', defenderSet, af)).toBe(true);

    // B is not acceptable with respect to {A} because C attacks B and A doesn't attack C
    expect(semantics.isAcceptable('B', new Set(['A']), af)).toBe(false);
  });

  /**
   * Test admissibility
   */
  test('Admissible set detection', () => {
    const af: ArgumentationFramework = {
      arguments: [
        { id: 'A', content: 'Claim A' },
        { id: 'B', content: 'Claim B' },
      ],
      attacks: [{ attacker: 'B', target: 'A' }],
    };

    // {B} is admissible: conflict-free and B defends itself
    expect(semantics.isAdmissible(new Set(['B']), af)).toBe(true);

    // {A, B} is not admissible: not conflict-free
    expect(semantics.isAdmissible(new Set(['A', 'B']), af)).toBe(false);

    // Empty set is always admissible
    expect(semantics.isAdmissible(new Set(), af)).toBe(true);
  });

  /**
   * Complexity limit test
   */
  test('Complexity limit for large frameworks', () => {
    const largeAf: ArgumentationFramework = {
      arguments: Array.from({ length: 21 }, (_, i) => ({
        id: `A${i}`,
        content: `Argument ${i}`,
      })),
      attacks: [],
    };

    expect(() => groundedExtension(largeAf)).toThrow(/too large/);
    expect(() => preferredExtensions(largeAf)).toThrow(/too large/);
    expect(() => stableExtensions(largeAf)).toThrow(/too large/);
    expect(() => completeExtensions(largeAf)).toThrow(/too large/);
  });
});
