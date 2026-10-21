/**
 * LinUCB Contextual Bandit
 * Li et al. 2010, Algorithm 1: Disjoint Linear Upper Confidence Bound
 *
 * UCB_a = θ̂_a^T x_{t,a} + α × sqrt(x_{t,a}^T A_a^{-1} x_{t,a})
 *
 * Updates:
 * A_a ← A_a + x_{t,a} x_{t,a}^T
 * b_a ← b_a + r_t,a x_{t,a}
 */

import { invertMatrix, matVec, dot, addOuter, identity, zeros } from './matrix';

export interface LinUCBArm {
  id: string;
  A: number[][]; // d×d matrix
  b: number[]; // d-vector
}

export interface LinUCBContext {
  values: number[]; // d-dimensional context vector
}

export class LinUCB {
  readonly d: number;
  readonly alpha: number;

  constructor(d: number = 8, alpha: number = 0.5) {
    if (d <= 0) {
      throw new Error('Dimension d must be positive');
    }
    if (alpha < 0) {
      throw new Error('Alpha must be non-negative');
    }
    this.d = d;
    this.alpha = alpha;
  }

  /**
   * Initialize a new arm with identity matrix A and zero vector b
   */
  initializeArm(id: string): LinUCBArm {
    return {
      id,
      A: identity(this.d),
      b: zeros(this.d),
    };
  }

  /**
   * Select the arm with highest UCB
   * Returns the arm ID
   */
  chooseArm(arms: LinUCBArm[], context: LinUCBContext): string {
    if (arms.length === 0) {
      throw new Error('No arms available');
    }
    if (context.values.length !== this.d) {
      throw new Error(`Context dimension ${context.values.length} does not match d=${this.d}`);
    }

    let bestArm = arms[0];
    let bestUCB = -Infinity;

    for (const arm of arms) {
      try {
        const ucb = this.computeUCB(arm, context.values);
        if (ucb > bestUCB) {
          bestUCB = ucb;
          bestArm = arm;
        }
      } catch (err) {
        // Skip arms with singular matrices (shouldn't happen in practice)
        continue;
      }
    }

    return bestArm.id;
  }

  /**
   * Compute UCB for a single arm
   * UCB_a = θ̂_a^T x_{t,a} + α × sqrt(x_{t,a}^T A_a^{-1} x_{t,a})
   */
  private computeUCB(arm: LinUCBArm, context: number[]): number {
    // Compute θ̂_a = A_a^{-1} b_a
    const Ainv = invertMatrix(arm.A);
    const thetaHat = matVec(Ainv, arm.b);

    // Mean: θ̂_a^T x
    const mean = dot(thetaHat, context);

    // Variance: x^T A_a^{-1} x
    const AinvX = matVec(Ainv, context);
    const variance = dot(context, AinvX);

    // UCB
    const exploration = this.alpha * Math.sqrt(Math.max(0, variance));
    return mean + exploration;
  }

  /**
   * Update arm after observing reward
   * A_a ← A_a + x_{t,a} x_{t,a}^T
   * b_a ← b_a + r_t,a x_{t,a}
   */
  update(arm: LinUCBArm, context: number[], reward: number): LinUCBArm {
    if (context.length !== this.d) {
      throw new Error(`Context dimension ${context.length} does not match d=${this.d}`);
    }

    // Update A: A + x·x^T
    const A_new = addOuter(arm.A, context);

    // Update b: b + r·x
    const b_new = arm.b.map((bi, i) => bi + reward * context[i]);

    return {
      ...arm,
      A: A_new,
      b: b_new,
    };
  }

  /**
   * Batch update multiple arms
   */
  updateMultiple(arms: LinUCBArm[], updates: Array<{ armId: string; context: number[]; reward: number }>): LinUCBArm[] {
    const armMap = new Map(arms.map(arm => [arm.id, arm]));

    for (const upd of updates) {
      const arm = armMap.get(upd.armId);
      if (arm) {
        armMap.set(upd.armId, this.update(arm, upd.context, upd.reward));
      }
    }

    return arms.map(arm => armMap.get(arm.id)!);
  }
}

/**
 * Helper: Create 15 default arms (difficulty 1-5 × question_type d|a|c)
 * Arm ID format: d{1-5}_t{d|a|c}
 * d=definition, a=application, c=counterexample
 */
export function createDefaultArms(): LinUCBArm[] {
  const difficulties = [1, 2, 3, 4, 5];
  const types = ['d', 'a', 'c']; // definition, application, counterexample
  const arms: LinUCBArm[] = [];

  for (const diff of difficulties) {
    for (const type of types) {
      const id = `d${diff}_t${type}`;
      arms.push({
        id,
        A: identity(8),
        b: zeros(8),
      });
    }
  }

  return arms;
}
