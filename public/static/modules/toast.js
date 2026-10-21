// Toast notification module
// ESM export for v35 modularization

function showToast(msg, type='info') {
  const e = document.querySelector('.toast');
  if (e) e.remove();
  const d = document.createElement('div');
  d.className = 'toast toast-' + type;
  d.innerHTML = '<i class="fas fa-' + (type==='error'?'exclamation-circle':type==='success'?'check-circle':'info-circle') + ' mr-2"></i>' + msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 4000);
}

// Export for ESM
export { showToast };

// Legacy window bridge for backward compatibility (inline onclick)
if (typeof window !== 'undefined') {
  window.showToast = showToast;
}
