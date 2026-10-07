/** Creates an element, assigns `props` and appends `kids`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

/** An IPC error's message without Electron's "Error invoking remote method" prefix. */
export const errText = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** A small rubber key (button). */
export const key = (label: string, onclick: (() => void) | null = null, extra: Partial<HTMLButtonElement> = {}): HTMLButtonElement =>
  h('button', { type: 'button', className: 'key key--sm', textContent: label, onclick, ...extra });

/** Shows `form` in a modal in-app sheet, removed when it closes. */
export function sheet(label: string, form: HTMLFormElement, className = ''): HTMLDialogElement {
  const d = h('dialog', { className: `sheet ${className}`.trim() }, form);
  d.setAttribute('aria-label', label);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

/** A modal form sheet with Cancel and `ok`; `submit` returns an error message to show, or '' to close. */
export function formSheet(title: string, body: HTMLElement[], submit: () => Promise<string>, ok = 'Save', className = ''): HTMLDialogElement {
  const status = h('p', { className: 'pref-warn' });
  status.setAttribute('aria-live', 'polite');
  const go = h('button', { className: 'btn btn--primary', value: 'ok', textContent: ok });
  const form = h('form', { method: 'dialog' }, h('h2', { className: 'legend', textContent: title }), ...body, status,
    h('div', { className: 'sheet-keys' }, h('button', { className: 'btn', value: 'cancel', formNoValidate: true, textContent: 'Cancel' }), go));
  const dlg = sheet(title, form, className);
  form.onsubmit = async (ev) => {
    if (ev.submitter !== go) return;
    ev.preventDefault();
    go.disabled = true;
    status.textContent = await submit().catch(errText);
    go.disabled = false;
    if (!status.textContent) dlg.close();
  };
  return dlg;
}

/** A labelled form field, with an optional hint under it. */
export const field = (label: string, ctl: HTMLElement, hint?: string): HTMLLabelElement =>
  h('label', { className: 'field' }, h('span', { className: 'legend', textContent: label }), ctl, ...(hint ? [h('span', { className: 'pref-hint', textContent: hint })] : []));

/** A modal question with keys [value, label, className]; resolves with the picked value ('cancel' on Escape). Cancel comes first. */
export function choose(title: string, detail: string, keys: [string, string, string][]): Promise<string> {
  const d = sheet(title, h('form', { method: 'dialog' },
    h('p', { className: 'legend', textContent: title }),
    h('p', { className: 'pref-hint ask-detail', textContent: detail }),
    h('div', { className: 'sheet-keys' },
      h('button', { className: 'btn', value: 'cancel', textContent: 'Cancel' }),
      ...keys.map(([value, textContent, className]) => h('button', { className, value, textContent })))));
  return new Promise((r) => d.addEventListener('close', () => r(d.returnValue || 'cancel'), { once: true }));
}

/** A modal yes/no; resolves true when the user picks `ok`. */
export const ask = (title: string, detail: string, ok: string, danger = false): Promise<boolean> =>
  choose(title, detail, [['ok', ok, danger ? 'btn rm' : 'btn btn--primary']]).then((v) => v === 'ok');
