// The browser only manages row names and order, never edits entered values.
export const repeatableRowsScript = String.raw`
(() => {
  const renumber = (container) => {
    container.querySelectorAll('[data-row]').forEach((row, index) => {
      row.querySelectorAll('[name]').forEach((input) => {
        input.name = input.name.replace(/\[(?:\d+|__INDEX__)\]/, '[' + index + ']');
      });
    });
  };
  document.querySelectorAll('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const list = button.dataset.add;
      const container = document.querySelector('[data-rows="' + list + '"]');
      const template = document.getElementById(list + '-template');
      if (!container || !template) return;
      const row = template.content.firstElementChild.cloneNode(true);
      container.appendChild(row);
      renumber(container);
      const first = row.querySelector('input');
      if (first) first.focus();
    });
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    const row = button.closest('[data-row]');
    if (row) {
      const container = row.parentElement;
      row.remove();
      renumber(container);
    }
  });
})();`;
