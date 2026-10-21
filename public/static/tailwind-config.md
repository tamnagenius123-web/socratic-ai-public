# Tailwind Config 동기화 가이드 (v35 토큰)

## 개요
`public/index.html` 내 `<script>tailwind.config = {...}</script>` 블록을 새로운 CSS 변수 토큰과 동기화하는 방법.

## 구조

### 1. HTML 내 현재 Tailwind 설정
`index.html` 라인 16~33에 정의된 `tailwind.config` 객체는 CDN 로드 후 색상, 폰트 등을 확장합니다:

```javascript
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: { 50:'#EDE9FE', 100:'#DDD6FE', ... },
        success: '#10B981',
        // ...
      },
      fontFamily: { sans: ['Inter', 'Noto Sans KR', 'sans-serif'] }
    }
  }
}
```

### 2. 신규 토큰 기반 재매핑 (권장)
CSS 변수를 Tailwind 팔레트와 연결하여 색상을 중앙화합니다:

```javascript
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* Surface palette (배경층) */
        surface: {
          0: 'var(--surface-0)',      /* #FFFFFF light, #0E0E0C dark */
          1: 'var(--surface-1)',      /* #FAFAF7 light, #1A1A17 dark */
          2: 'var(--surface-2)',      /* #F3F2ED light, #252520 dark */
          3: 'var(--surface-3)',      /* #E8E6DE light, #36362F dark */
          inverse: 'var(--surface-inverse)'
        },
        /* Ink palette (텍스트층) */
        ink: {
          primary: 'var(--ink-primary)',
          secondary: 'var(--ink-secondary)',
          tertiary: 'var(--ink-tertiary)',
          disabled: 'var(--ink-disabled)',
          inverse: 'var(--ink-inverse)'
        },
        /* Signal palette (의미색) */
        signal: {
          insight: 'var(--signal-insight)',    /* #D97757 */
          progress: 'var(--signal-progress)',  /* #5B8C5A */
          friction: 'var(--signal-friction)',  /* #B85450 */
          thinking: 'var(--signal-thinking)'   /* #7B7A99 */
        },
        /* Action palette (상호작용층) */
        action: {
          primary: 'var(--action-primary)',
          'primary-hover': 'var(--action-primary-hover)',
          'ghost-hover': 'var(--action-ghost-hover)'
        },
        /* 하위호환성: 기존 primary */
        primary: {
          50: 'var(--surface-2)',
          500: 'var(--signal-insight)',    /* D97757 */
          600: 'var(--action-primary-hover)',
          700: 'var(--action-primary-hover)'
          /* ... 필요시 추가 */
        }
      },
      spacing: {
        0: 'var(--space-0)',
        1: 'var(--space-1)',
        2: 'var(--space-2)',
        3: 'var(--space-3)',
        4: 'var(--space-4)',
        6: 'var(--space-6)',
        8: 'var(--space-8)',
        12: 'var(--space-12)',
        16: 'var(--space-16)',
        24: 'var(--space-24)'
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)'
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)'
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans KR', 'sans-serif']
      }
    }
  }
}
```

## 사용 예시

### 클래스 형식
```html
<!-- 새 토큰 사용 (권장) -->
<div class="bg-surface-0 text-ink-primary rounded-lg shadow-1">
  ...
</div>

<!-- 하위호환 (기존 primary 유지) -->
<button class="bg-primary-500 text-white">...</button>
```

### 인라인 스타일
```html
<!-- 되도록 지양, 필요 시 CSS 변수만 -->
<div style="background-color: var(--surface-1); color: var(--ink-primary);">
  ...
</div>
```

## 주의사항

1. **동적 클래스 생성 금지**: Tailwind는 정적 클래스만 감지.
   ```javascript
   // ❌ 금지
   el.className = `bg-${colorVar}-50`;
   
   // ✓ 권장: CSS 변수 또는 사전 정의된 클래스
   el.style.backgroundColor = `var(--surface-${index})`;
   el.classList.add('bg-surface-1');
   ```

2. **Safelist 사용** (동적 클래스 필요 시):
   ```javascript
   // tailwind.config에 추가
   safelist: [
     'bg-surface-0', 'bg-surface-1', 'bg-surface-2',
     'text-ink-primary', 'text-signal-insight'
   ]
   ```

3. **다크모드 전환**: `html[data-theme="dark"]` 속성 변경 시 CSS 변수가 자동 갱신되므로 Tailwind 클래스도 함께 반영.

## 마이그레이션 전략

1. **Phase 1**: 위 Tailwind config 객체 적용 (색상 오버라이드 없음, 기존 동작 유지)
2. **Phase 2**: 신규 토큰 클래스 (`bg-surface-*`, `text-ink-*`) 사용처 점진 추가
3. **Phase 3**: 기존 color 정의 (`bg-blue-500` 등) 완전 제거 (별도 PR)

## 검증

마이그레이션 후 색상 일관성 확인:
```bash
# CSS 변수 개수 확인
grep -c "^  --" public/static/styles.css  # v35: 40+ 토큰

# Tailwind 동적 클래스 확인 (0개 목표)
grep -r "'bg-" public/src --include="*.js" | wc -l
```
