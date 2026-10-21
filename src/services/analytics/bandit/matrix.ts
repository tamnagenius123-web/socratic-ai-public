/**
 * Matrix Utilities for LinUCB
 * Small dense matrix operations: d×d matrices, d ≤ 10
 * Gaussian-Jordan elimination for inversion
 */

export function invertMatrix(A: number[][]): number[][] {
  const n = A.length;

  // Validate square matrix
  if (!A.every(row => row.length === n)) {
    throw new Error('Matrix must be square');
  }

  // Create augmented matrix [A | I]
  const aug: number[][] = A.map((row, i) => [
    ...row.map(x => x),
    ...(Array(n).fill(0).map((_, j) => i === j ? 1 : 0))
  ]);

  // Gaussian-Jordan elimination
  for (let col = 0; col < n; col++) {
    // Find pivot (largest absolute value in column)
    let pivotRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        pivotRow = row;
      }
    }

    // Check singularity
    if (Math.abs(aug[pivotRow][col]) < 1e-12) {
      throw new Error('Matrix is singular or nearly singular');
    }

    // Swap rows
    [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];

    // Scale pivot row
    const pivot = aug[col][col];
    for (let j = 0; j < 2 * n; j++) {
      aug[col][j] /= pivot;
    }

    // Eliminate column in other rows
    for (let row = 0; row < n; row++) {
      if (row !== col) {
        const factor = aug[row][col];
        for (let j = 0; j < 2 * n; j++) {
          aug[row][j] -= factor * aug[col][j];
        }
      }
    }
  }

  // Extract inverse from right side of augmented matrix
  const inv: number[][] = aug.map(row => row.slice(n));
  return inv;
}

export function matVec(A: number[][], x: number[]): number[] {
  if (A.length !== x.length || !A.every(row => row.length === x.length)) {
    throw new Error('Dimension mismatch: A must be square matrix with same dimension as x');
  }

  const result: number[] = [];
  for (let i = 0; i < A.length; i++) {
    let sum = 0;
    for (let j = 0; j < x.length; j++) {
      sum += A[i][j] * x[j];
    }
    result.push(sum);
  }
  return result;
}

export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vector dimension mismatch');
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export function addOuter(A: number[][], x: number[]): number[][] {
  const n = A.length;
  if (x.length !== n || !A.every(row => row.length === n)) {
    throw new Error('Dimension mismatch');
  }

  // Compute A + x·x^T
  const result = A.map(row => [...row]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      result[i][j] += x[i] * x[j];
    }
  }
  return result;
}

/**
 * Create identity matrix of size n×n
 */
export function identity(n: number): number[][] {
  const I: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      row.push(i === j ? 1 : 0);
    }
    I.push(row);
  }
  return I;
}

/**
 * Zero vector of length n
 */
export function zeros(n: number): number[] {
  return Array(n).fill(0);
}
