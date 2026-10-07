/** Creates an element, assigns `props` and appends `kids`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

/** A small rubber key (button). */
export const key = (label: string, onclick: (() => void) | null = null, extra: Partial<HTMLButtonElement> = {}): HTMLButtonElement =>
  h('button', { type: 'button', className: 'key key--sm', textContent: label, onclick, ...extra });
