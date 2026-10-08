/** Creates an element, assigns `props` and appends `kids`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

/** An IPC error's message without Electron's "Error invoking remote method" prefix. */
export const errText = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Puts `kids` in `parent` only if they differ, so a kept node (a card being typed in, an open fold) is never moved. */
export function setKids(parent: Element, kids: Node[]): void {
  if (kids.length !== parent.childNodes.length || kids.some((k, i) => parent.childNodes[i] !== k)) parent.replaceChildren(...kids);
}

/** Alt+Enter in `box` presses `ok`; Enter stays a new line. A box inside a form needs nothing: app.ts submits the form. */
export function okKey(box: HTMLElement, ok: HTMLButtonElement): void {
  ok.setAttribute('aria-keyshortcuts', 'Alt+Enter');
  box.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || !ev.altKey || ev.isComposing) return;
    ev.preventDefault();
    if (!ok.disabled) ok.click();
  });
}

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

let segN = 0;
/** A row of radio keys; options are values or [value, label]. `get` reads the checked one; the first is checked when `value` is none of them. */
export function seg(label: string, options: (string | [string, string])[], value: string, onpick?: (v: string) => void, disabled: string[] = []): { el: HTMLFieldSetElement; get(): string } {
  const name = `seg-${++segN}`;
  const el = h('fieldset', { className: 'seg' }, h('legend', { className: 'legend', textContent: label }));
  options.forEach((o, i) => {
    const [v, l] = typeof o === 'string' ? [o, o] : o;
    el.append(h('input', { type: 'radio', name, id: `${name}-${i}`, value: v, checked: v === value, disabled: disabled.includes(v), onchange: () => onpick?.(v) }),
      h('label', { className: 'key key--sm', htmlFor: `${name}-${i}`, textContent: l }));
  });
  const first = el.querySelector('input');
  if (first && !el.querySelector('input:checked')) first.checked = true;
  return { el, get: () => (el.querySelector('input:checked') as HTMLInputElement | null)?.value ?? '' };
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
