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
