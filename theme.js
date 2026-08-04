(function () {
  const stored = localStorage.getItem('valecare-theme');
  const theme = stored || 'light';
  document.documentElement.setAttribute('data-theme', theme);

  window.addEventListener('DOMContentLoaded', () => {
    const buttons = document.querySelectorAll('[data-theme-btn]');
    function sync() {
      const current = document.documentElement.getAttribute('data-theme');
      buttons.forEach((b) => b.classList.toggle('active', b.dataset.themeBtn === current));
    }
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.themeBtn;
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('valecare-theme', value);
        sync();
      });
    });
    sync();
  });
})();
