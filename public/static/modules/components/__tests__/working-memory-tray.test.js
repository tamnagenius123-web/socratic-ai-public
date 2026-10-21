// ======================================================
// Working Memory Tray Component Tests
// Vitest: 5개 핵심 케이스
// ======================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountWorkingMemoryTray } from '../working-memory-tray.js';

describe('Working Memory Tray Component', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  // -------- Test 1: 초기 렌더링 --------
  it('초기 칩 없이 마운트되고 빈 상태로 렌더링된다', () => {
    const api = mountWorkingMemoryTray(container, {
      initialChips: [],
      maxChips: 4
    });

    const chipList = container.querySelector('.wmt-chips-list');
    expect(chipList).toBeDefined();
    expect(chipList.children.length).toBe(0);
    expect(api.getChips()).toEqual([]);
  });

  // -------- Test 2: 4칩 이하 정상 동작 --------
  it('4칩까지 정상적으로 추가되고 노출된다', () => {
    const api = mountWorkingMemoryTray(container, {
      initialChips: [],
      maxChips: 4
    });

    api.addChip('Schema A', 'variable');
    api.addChip('Schema B', 'variable');
    api.addChip('Context C', 'context');
    api.addChip('Note D', 'note');

    const chipList = container.querySelector('.wmt-chips-list');
    expect(chipList.children.length).toBe(4);
    expect(api.getChips().length).toBe(4);

    // 각 칩의 라벨 검증
    const labels = Array.from(chipList.querySelectorAll('.wmt-chip-label'))
      .map(el => el.textContent);
    expect(labels).toContain('Schema A');
    expect(labels).toContain('Schema B');
    expect(labels).toContain('Context C');
    expect(labels).toContain('Note D');
  });

  // -------- Test 3: 5개째 추가 시 오래된 unpinned 칩 축출 --------
  it('5개째 칩 추가 시 가장 오래된 unpinned 칩이 축출된다', (done) => {
    const onEvict = vi.fn();
    const api = mountWorkingMemoryTray(container, {
      initialChips: [],
      maxChips: 4,
      onEvict
    });

    // 칩 4개 추가
    const id1 = api.addChip('Chip 1', 'variable');
    const id2 = api.addChip('Chip 2', 'variable');
    const id3 = api.addChip('Chip 3', 'variable');
    const id4 = api.addChip('Chip 4', 'variable');

    expect(api.getChips().length).toBe(4);

    // 5개째 칩 추가 → Chip 1 축출 (가장 오래됨)
    api.addChip('Chip 5', 'variable');

    // 애니메이션 대기 (--duration-slow = 400ms)
    setTimeout(() => {
      expect(api.getChips().length).toBe(4);

      const remainingLabels = api.getChips().map(c => c.label);
      expect(remainingLabels).toContain('Chip 2');
      expect(remainingLabels).toContain('Chip 3');
      expect(remainingLabels).toContain('Chip 4');
      expect(remainingLabels).toContain('Chip 5');
      expect(remainingLabels).not.toContain('Chip 1');

      // onEvict 콜백 호출 검증
      expect(onEvict).toHaveBeenCalledWith(id1);
      done();
    }, 500);
  });

  // -------- Test 4: Pinned 칩은 자동 축출에서 제외 --------
  it('pinned 칩은 자동 축출 대상에서 제외된다', (done) => {
    const onEvict = vi.fn();
    const api = mountWorkingMemoryTray(container, {
      initialChips: [],
      maxChips: 4,
      onEvict
    });

    const id1 = api.addChip('Chip 1', 'variable');
    const id2 = api.addChip('Chip 2', 'variable');
    const id3 = api.addChip('Chip 3', 'variable');
    const id4 = api.addChip('Chip 4', 'variable');

    // Chip 1 고정 (가장 오래되었지만 보호)
    api.setPinned(id1, true);

    // 5개째 추가 → Chip 2 축출 (Chip 1은 pinned이므로 제외)
    api.addChip('Chip 5', 'variable');

    setTimeout(() => {
      expect(api.getChips().length).toBe(4);

      const remaining = api.getChips();
      const chip1 = remaining.find(c => c.label === 'Chip 1');
      expect(chip1).toBeDefined();
      expect(chip1.pinned).toBe(true);

      expect(remaining.find(c => c.label === 'Chip 2')).toBeUndefined();
      expect(onEvict).toHaveBeenCalledWith(id2);
      done();
    }, 500);
  });

  // -------- Test 5: 커스텀 onEvict 콜백 호출 --------
  it('칩 축출 시 커스텀 onEvict 콜백이 올바르게 호출된다', (done) => {
    const evictedChips = [];
    const onEvict = vi.fn((chipId) => {
      evictedChips.push(chipId);
    });

    const api = mountWorkingMemoryTray(container, {
      initialChips: [],
      maxChips: 4,
      onEvict
    });

    const ids = [];
    for (let i = 1; i <= 6; i++) {
      ids.push(api.addChip(`Chip ${i}`, 'variable'));
    }

    // 첫 번째 축출 (Chip 1, 2)
    setTimeout(() => {
      expect(onEvict.mock.calls.length).toBeGreaterThanOrEqual(1);

      // 축출된 칩 ID 검증
      expect(evictedChips).toContain(ids[0]); // Chip 1

      // 현재 칩 상태
      const current = api.getChips();
      expect(current.length).toBe(4);

      done();
    }, 500);
  });

  // -------- 보너스: Pin/Unpin 토글 동작 --------
  it('Pin/Unpin 토글이 정상 동작한다', () => {
    const api = mountWorkingMemoryTray(container, {
      initialChips: [],
      maxChips: 4
    });

    const id1 = api.addChip('Chip 1', 'variable');
    let chips = api.getChips();
    expect(chips[0].pinned).toBe(false);

    api.setPinned(id1, true);
    chips = api.getChips();
    expect(chips[0].pinned).toBe(true);

    api.setPinned(id1, false);
    chips = api.getChips();
    expect(chips[0].pinned).toBe(false);
  });

  // -------- 보너스: Clear 동작 --------
  it('clear() 메서드가 모든 칩을 제거한다', () => {
    const api = mountWorkingMemoryTray(container, {
      initialChips: [],
      maxChips: 4
    });

    api.addChip('Chip 1', 'variable');
    api.addChip('Chip 2', 'variable');
    expect(api.getChips().length).toBe(2);

    api.clear();
    expect(api.getChips().length).toBe(0);

    const chipList = container.querySelector('.wmt-chips-list');
    expect(chipList.children.length).toBe(0);
  });
});
