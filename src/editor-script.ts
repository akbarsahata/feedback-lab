export const formatSwitchScript = String.raw`
(() => {
  const form = document.getElementById('assignment-form');
  if (!form) return;
  const select = form.querySelector('select[name="format"]');
  const testTemplate = document.getElementById('tests-template');
  const warning = document.getElementById('format-switch-warning');
  if (!select) return;
  const update = () => {
    const format = select.value;
    for (const root of [form, testTemplate.content]) {
      root.querySelectorAll('[data-format-field]').forEach((field) => {
        field.classList.toggle('is-hidden', field.dataset.formatField !== format);
      });
    }
    document.querySelectorAll('[data-format-note]').forEach((note) => {
      note.hidden = note.dataset.formatNote !== format;
    });
    const entryPoint = form.querySelector('input[name="entryPoint"]');
    if (entryPoint) entryPoint.required = format === 'function';
    if (warning) warning.hidden = format === form.dataset.initialFormat;
  };
  select.addEventListener('change', update);
  form.addEventListener('formdata', ({ formData }) => {
    if (select.value !== 'script') return;
    form.querySelectorAll('textarea[data-exact-text]').forEach((field) => {
      // Forms convert line breaks to CRLF. JSON-encode the text for transport,
      // and retain the original bytes when the browser-normalized value is unchanged.
      const name = field.name.replace(/\]$/, 'Text]');
      const text = field.value === field.defaultValue
        ? field.dataset.exactText
        : JSON.stringify(field.value);
      formData.delete(field.name);
      formData.set(name, text);
    });
  });
  update();
})();`;

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
