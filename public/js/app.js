document.addEventListener('DOMContentLoaded', function () {
  // FAQ Accordion
  document.querySelectorAll('.faq-question').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = this.closest('.faq-item');
      var wasActive = item.classList.contains('active');
      document.querySelectorAll('.faq-item').forEach(function (el) {
        el.classList.remove('active');
      });
      if (!wasActive) item.classList.add('active');
    });
  });

  // Mobile Nav
  var toggle = document.querySelector('.mobile-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      document.querySelector('nav').classList.toggle('active');
    });
  }

  // Close modal on overlay click
  document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.classList.remove('active');
    });
  });
});
