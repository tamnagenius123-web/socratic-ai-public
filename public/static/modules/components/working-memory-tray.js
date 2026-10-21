// ======================================================
// Working Memory Tray Component
// Cognitive Load Theory (CLT) 구현: 4칩 상한
// 근거: Sweller et al. (2011) pp. 41-43 (2~3개 처리 항목)
//       + Cowan (2001) 4±1 모델
// ======================================================

/**
 * mountWorkingMemoryTray - 작업 기억 보조 트레이 컴포넌트
 *
 * @param {HTMLElement} container - 컴포넌트가 마운트될 컨테이너
 * @param {Object} options - 옵션
 * @param {Array} options.initialChips - 초기 칩 배열
 *   칩 구조: { id, label, type, value?, pinned, addedAt }
 * @param {number} options.maxChips - 최대 칩 수 (기본값: 4)
 * @param {Function} options.onEvict - 칩 축출 시 콜백 (chipId) => void
 *
 * @returns {Object} API: { addChip, removeChip, setPinned, getChips, clear }
 */
export function mountWorkingMemoryTray(container, options = {}) {
  const {
    initialChips = [],
    maxChips = 4,
    onEvict = () => {}
  } = options;

  let chips = initialChips.map(c => ({
    id: c.id || `chip-${Date.now()}-${Math.random()}`,
    label: c.label || '',
    type: c.type || 'variable',
    value: c.value || undefined,
    pinned: c.pinned || false,
    addedAt: c.addedAt || Date.now()
  }));

  // DOM 구조 생성
  const tray = document.createElement('div');
  tray.className = 'wmt-container';
  tray.setAttribute('role', 'region');
  tray.setAttribute('aria-label', '작업 기억 칩 트레이');

  const chipContainer = document.createElement('div');
  chipContainer.className = 'wmt-chips-scroll';

  const chipList = document.createElement('div');
  chipList.className = 'wmt-chips-list';

  chipContainer.appendChild(chipList);
  tray.appendChild(chipContainer);
  container.appendChild(tray);

  // CSS 동적 삽입 (인라인 스타일 회피, CSS 변수 사용)
  if (!document.getElementById('wmt-styles')) {
    const style = document.createElement('style');
    style.id = 'wmt-styles';
    style.textContent = `
      /* Working Memory Tray Styles */
      .wmt-container {
        display: flex;
        align-items: center;
        background: var(--surface-1, #FAFAF7);
        border-top: 1px solid var(--surface-3, #E8E6DE);
        padding: var(--space-3, 12px) var(--space-4, 16px);
        overflow-x: auto;
        overflow-y: hidden;
        max-width: 100%;
        gap: var(--space-2, 8px);
      }

      .wmt-chips-scroll {
        flex: 1;
        display: flex;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-behavior: smooth;
        gap: var(--space-2, 8px);
        padding-bottom: var(--space-1, 4px);
      }

      /* Firefox 스크롤바 숨김 */
      .wmt-chips-scroll {
        scrollbar-width: none;
      }
      .wmt-chips-scroll::-webkit-scrollbar {
        display: none;
      }

      .wmt-chips-list {
        display: flex;
        gap: var(--space-2, 8px);
        flex-wrap: nowrap;
        flex-shrink: 0;
      }

      .wmt-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1, 4px);
        background: var(--surface-2, #F3F2ED);
        color: var(--ink-primary, #0E0E0C);
        border: 1px solid var(--surface-3, #E8E6DE);
        border-radius: var(--radius-md, 10px);
        padding: var(--space-1, 4px) var(--space-3, 12px);
        font-size: 13px;
        line-height: 1.4;
        font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
        white-space: nowrap;
        flex-shrink: 0;
        transition: all var(--duration-base, 200ms) var(--ease-standard, cubic-bezier(0.2, 0.0, 0.0, 1));
      }

      .wmt-chip[data-pinned="true"] {
        background: var(--signal-insight, #D97757);
        color: var(--ink-inverse, #FAFAF7);
        border-color: var(--signal-insight, #D97757);
      }

      .wmt-chip:hover {
        box-shadow: var(--shadow-1, 0 1px 2px rgba(14,14,12,0.06), 0 1px 3px rgba(14,14,12,0.04));
      }

      .wmt-chip[data-pinned="true"]:hover {
        box-shadow: 0 2px 6px rgba(217, 119, 87, 0.2);
      }

      .wmt-chip.fading-out {
        animation: wmtFadeOut var(--duration-slow, 400ms) var(--ease-standard, cubic-bezier(0.2, 0.0, 0.0, 1)) forwards;
      }

      @keyframes wmtFadeOut {
        from {
          opacity: 1;
          transform: scaleX(1);
        }
        to {
          opacity: 0;
          transform: scaleX(0.95);
        }
      }

      .wmt-chip-pin-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 0;
        background: none;
        border: none;
        cursor: pointer;
        color: inherit;
        font-size: 12px;
        opacity: 0.7;
        transition: opacity var(--duration-base, 200ms);
      }

      .wmt-chip-pin-btn:hover {
        opacity: 1;
      }

      .wmt-chip[data-pinned="true"] .wmt-chip-pin-btn {
        opacity: 1;
      }

      .wmt-chip-label {
        user-select: none;
      }

      /* 모바일 (max-width: 639px) */
      @media (max-width: 639px) {
        .wmt-container {
          padding: var(--space-2, 8px) var(--space-3, 12px);
        }

        .wmt-chip {
          font-size: 12px;
          padding: var(--space-1, 4px) var(--space-2, 8px);
        }
      }

      /* 태블릿 (640px ~ 1023px) */
      @media (min-width: 640px) and (max-width: 1023px) {
        .wmt-container {
          padding: var(--space-3, 12px) var(--space-4, 16px);
        }
      }

      /* 접근성: prefers-reduced-motion */
      @media (prefers-reduced-motion: reduce) {
        .wmt-chip,
        .wmt-chip.fading-out {
          animation: none;
          transition: none;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // 렌더링 함수
  function render() {
    chipList.innerHTML = '';
    chips.forEach(chip => {
      const chipEl = document.createElement('div');
      chipEl.className = 'wmt-chip';
      chipEl.setAttribute('data-chip-id', chip.id);
      chipEl.setAttribute('data-pinned', String(chip.pinned));
      chipEl.setAttribute('aria-label', `칩: ${chip.label}${chip.value ? ` = ${chip.value}` : ''}${chip.pinned ? ', 고정됨' : ''}`);

      const label = document.createElement('span');
      label.className = 'wmt-chip-label';
      label.textContent = chip.label + (chip.value ? ': ' + chip.value : '');

      const pinBtn = document.createElement('button');
      pinBtn.className = 'wmt-chip-pin-btn';
      pinBtn.type = 'button';
      pinBtn.textContent = chip.pinned ? '📌' : '📍';
      pinBtn.setAttribute('aria-label', chip.pinned ? '고정 해제' : '고정');
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePin(chip.id);
      });

      chipEl.appendChild(label);
      chipEl.appendChild(pinBtn);
      chipList.appendChild(chipEl);
    });
  }

  // 핵심 로직: 5개째 칩 추가 시 가장 오래된 unpinned 칩 축출
  function evictOldestUnpinned() {
    const unpinned = chips.filter(c => !c.pinned).sort((a, b) => a.addedAt - b.addedAt);
    if (unpinned.length > 0) {
      const victim = unpinned[0];
      removeChipWithAnimation(victim.id);
      onEvict(victim.id);
    }
  }

  function removeChipWithAnimation(chipId) {
    const chipEl = chipList.querySelector(`[data-chip-id="${chipId}"]`);
    if (chipEl) {
      chipEl.classList.add('fading-out');
      setTimeout(() => {
        chips = chips.filter(c => c.id !== chipId);
        render();
      }, 400); // --duration-slow와 동일
    } else {
      chips = chips.filter(c => c.id !== chipId);
      render();
    }
  }

  function togglePin(chipId) {
    const chip = chips.find(c => c.id === chipId);
    if (chip) {
      chip.pinned = !chip.pinned;
      render();
    }
  }

  // 공개 API
  const api = {
    addChip(label, type = 'variable', value = undefined) {
      const newChip = {
        id: `chip-${Date.now()}-${Math.random()}`,
        label,
        type,
        value,
        pinned: false,
        addedAt: Date.now()
      };
      chips.push(newChip);

      // CLT 상한: 4칩
      if (chips.length > maxChips) {
        evictOldestUnpinned();
      }

      render();
      return newChip.id;
    },

    removeChip(chipId) {
      removeChipWithAnimation(chipId);
    },

    setPinned(chipId, pinned) {
      const chip = chips.find(c => c.id === chipId);
      if (chip) {
        chip.pinned = Boolean(pinned);
        render();
      }
    },

    getChips() {
      return chips.map(c => ({ ...c }));
    },

    clear() {
      chips = [];
      render();
    }
  };

  // 초기 렌더
  render();

  return api;
}
