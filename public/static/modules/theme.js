// SocraticAI v35 — Theme management
function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  document.documentElement.classList.toggle('dark', next === 'dark');
  document.querySelectorAll('.dark-mode-icon').forEach((icon) => {
    icon.className = icon.className.replace(/fa-moon|fa-sun/, next === 'dark' ? 'fa-sun' : 'fa-moon');
  });
  document.querySelectorAll('.dark-mode-text').forEach((label) => {
    label.textContent = next === 'dark' ? '라이트모드' : '다크모드';
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = next === 'dark' ? '#0E0E0C' : '#D97757';
}

function toggleDarkMode() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
  window.showToast?.(next === 'dark' ? '다크모드로 전환되었습니다.' : '라이트모드로 전환되었습니다.', 'info');
}

function initAutoTheme() {
  const saved = localStorage.getItem('theme');
  const preferred = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(saved || preferred);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (!localStorage.getItem('theme')) applyTheme(event.matches ? 'dark' : 'light');
  });
}

export { toggleDarkMode, initAutoTheme };
window.toggleDarkMode = toggleDarkMode;
