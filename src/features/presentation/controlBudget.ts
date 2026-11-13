/** Authored operator controls, independent of native render/texture budgets. */
export const MAX_SET_CONTROLS = 128;

export function setControlBudget(doc: {set: {controls: readonly {type: string}[]}}) {
  const used = doc.set.controls.length;
  return {
    used, limit: MAX_SET_CONTROLS, remaining: Math.max(0, MAX_SET_CONTROLS - used),
    counts: {
      button: doc.set.controls.filter(control => control.type === 'button').length,
      text: doc.set.controls.filter(control => control.type === 'text').length,
      number: doc.set.controls.filter(control => control.type === 'number').length,
    },
    scope: 'All authored buttons, text fields and numeric controls share this limit. Registered operator components have a separate limit.',
  };
}
